/*
 * uia-probe — Scribe's native Windows accessibility reader (screen agent).
 *
 * Long-running stdio server: reads one JSON command per line on stdin, writes
 * one JSON response per line on stdout. Enumerates the FOREGROUND window's
 * interactive controls via UI Automation and acts on them by id.
 *
 * Design follows Microsoft UFO²'s inspector (github.com/microsoft/UFO,
 * ufo/automator/ui_control/inspector.py):
 *   - ONE FindAll(TreeScope.Descendants) with a CacheRequest for exactly
 *     Name / ControlType / BoundingRectangle — property reads are cross-process
 *     COM round-trips, so everything is prefetched in a single call.
 *   - Condition: IsEnabled && !IsOffscreen && IsControlElement && an
 *     OrCondition over interactive control types.
 *   - Hard cap on elements; read only Cached properties afterwards.
 *   - Act via InvokePattern / ValuePattern when supported (atomic, reliable);
 *     the caller falls back to physical clicks at the cached rectangle center.
 *
 * Commands (one per line):
 *   {"cmd":"dump"}                                → foreground window + elements
 *   {"cmd":"dump","hwnd":N}                       → same, for a PINNED window
 *                                                   (agent stays scoped to the
 *                                                   app it is driving even if
 *                                                   focus wanders)
 *   {"cmd":"invoke","id":N}                       → InvokePattern.Invoke()
 *   {"cmd":"setvalue","id":N,"text":"..."}        → focus + ValuePattern.SetValue
 *   {"cmd":"focus","id":N}                        → SetFocus() (before typing)
 *   {"cmd":"windows"}                             → visible top-level windows
 *                                                   (fallback when there is no
 *                                                   foreground window, and to
 *                                                   focus a just-launched app)
 *   {"cmd":"ping"}                                → liveness
 *
 * Runs OUT of the Electron process on purpose: a hung UIA provider (frozen
 * app) blocks only this probe, which the caller times out and restarts.
 *
 * Build (no SDK needed — .NET Framework's csc):
 *   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /o+
 *     /out:uia-probe.exe /win32manifest:uia-probe.manifest
 *     /r:UIAutomationClient.dll /r:UIAutomationTypes.dll /r:WindowsBase.dll
 *     uia-probe.cs
 */
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;

static class Probe
{
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hwnd, StringBuilder s, int max);
    [DllImport("user32.dll")]
    static extern int GetWindowTextLength(IntPtr hwnd);
    [DllImport("user32.dll")]
    static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    const uint GW_OWNER = 4;
    [DllImport("user32.dll")]
    static extern long GetWindowLong(IntPtr hwnd, int idx);
    const int GWL_EXSTYLE = -20;
    const long WS_EX_TOOLWINDOW = 0x00000080;

    [DllImport("user32.dll")]
    static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassName(IntPtr hwnd, StringBuilder s, int max);

    static string ClassOf(IntPtr h)
    {
        var sb = new StringBuilder(128);
        GetClassName(h, sb, sb.Capacity);
        return sb.ToString();
    }

    static string TitleOf(IntPtr h)
    {
        int len = GetWindowTextLength(h);
        if (len <= 0) return "";
        var sb = new StringBuilder(len + 1);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    /**
     * UWP apps (Calculator, Settings, Photos…) are hosted by
     * ApplicationFrameHost: the "ApplicationFrameWindow" exposes almost no UIA,
     * while the real UI is a SEPARATE top-level "Windows.UI.Core.CoreWindow"
     * (owned by the app's own process) with the same title. Resolve the frame
     * to that CoreWindow so FindAll sees the actual controls. Normal Win32/WPF
     * apps are returned unchanged.
     */
    static IntPtr ResolveContentWindow(IntPtr frame)
    {
        if (ClassOf(frame) != "ApplicationFrameWindow") return frame;
        string title = TitleOf(frame);
        IntPtr core = IntPtr.Zero;
        EnumWindows((h, l) =>
        {
            if (ClassOf(h) == "Windows.UI.Core.CoreWindow" && TitleOf(h) == title) { core = h; return false; }
            return true;
        }, IntPtr.Zero);
        return core != IntPtr.Zero ? core : frame;
    }

    // PerMonitorV2 is also declared in the manifest; this is the runtime
    // fallback so a manifest-stripped build still reports physical pixels.
    static readonly IntPtr DPI_PER_MONITOR_V2 = new IntPtr(-4);
    [DllImport("user32.dll")]
    static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    const int MAX_ELEMENTS = 400;
    const int DUMP_TIMEOUT_MS = 2000; // frozen target apps block FindAll forever

    // Elements from the last dump, invokable by index until the next dump.
    static AutomationElement[] lastElements = new AutomationElement[0];
    static IntPtr lastHwnd = IntPtr.Zero;

    static readonly ControlType[] InteractiveTypes = new[] {
        ControlType.Button, ControlType.Edit, ControlType.ComboBox,
        ControlType.CheckBox, ControlType.RadioButton, ControlType.Hyperlink,
        ControlType.ListItem, ControlType.MenuItem, ControlType.TabItem,
        ControlType.TreeItem, ControlType.SplitButton, ControlType.Slider,
        ControlType.Spinner, ControlType.DataItem, ControlType.Document,
        ControlType.Text, // labels are useful context and often clickable rows
    };

    static Condition BuildCondition()
    {
        var typeConds = new Condition[InteractiveTypes.Length];
        for (int i = 0; i < InteractiveTypes.Length; i++)
            typeConds[i] = new PropertyCondition(AutomationElement.ControlTypeProperty, InteractiveTypes[i]);
        return new AndCondition(
            new PropertyCondition(AutomationElement.IsEnabledProperty, true),
            new PropertyCondition(AutomationElement.IsOffscreenProperty, false),
            new PropertyCondition(AutomationElement.IsControlElementProperty, true),
            new OrCondition(typeConds));
    }

    static readonly Condition InteractiveCondition = BuildCondition();

    static CacheRequest BuildCacheRequest()
    {
        var cr = new CacheRequest();
        cr.Add(AutomationElement.NameProperty);
        cr.Add(AutomationElement.ControlTypeProperty);
        cr.Add(AutomationElement.BoundingRectangleProperty);
        cr.Add(AutomationElement.IsKeyboardFocusableProperty);
        cr.Add(InvokePattern.Pattern);
        cr.Add(ValuePattern.Pattern);
        cr.Add(TogglePattern.Pattern);
        cr.Add(SelectionItemPattern.Pattern);
        cr.TreeScope = TreeScope.Element;
        // Full mode keeps a live reference so invoke/setvalue work post-dump.
        cr.AutomationElementMode = AutomationElementMode.Full;
        return cr;
    }

    // --- minimal JSON writer (no external deps on .NET Framework) ---

    static string J(string s)
    {
        if (s == null) return "\"\"";
        var b = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"') b.Append("\\\"");
            else if (c == '\\') b.Append("\\\\");
            else if (c < ' ') b.Append(string.Format("\\u{0:x4}", (int)c));
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }

    static string N(double d)
    {
        if (double.IsNaN(d) || double.IsInfinity(d)) d = 0;
        return Math.Round(d).ToString(CultureInfo.InvariantCulture);
    }

    // --- crude field extraction for our tiny fixed command grammar ---

    static string GetStr(string json, string key)
    {
        int k = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
        if (k < 0) return null;
        int colon = json.IndexOf(':', k);
        if (colon < 0) return null;
        int q1 = json.IndexOf('"', colon + 1);
        if (q1 < 0) return null;
        var b = new StringBuilder();
        for (int i = q1 + 1; i < json.Length; i++)
        {
            char c = json[i];
            if (c == '\\' && i + 1 < json.Length)
            {
                char n = json[++i];
                if (n == 'n') b.Append('\n');
                else if (n == 't') b.Append('\t');
                else if (n == 'u' && i + 4 < json.Length)
                {
                    b.Append((char)Convert.ToInt32(json.Substring(i + 1, 4), 16));
                    i += 4;
                }
                else b.Append(n);
            }
            else if (c == '"') break;
            else b.Append(c);
        }
        return b.ToString();
    }

    static long GetLong(string json, string key)
    {
        int k = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
        if (k < 0) return -1;
        int colon = json.IndexOf(':', k);
        if (colon < 0) return -1;
        int i = colon + 1;
        while (i < json.Length && (json[i] == ' ' || json[i] == '"')) i++;
        int start = i;
        while (i < json.Length && char.IsDigit(json[i])) i++;
        long v;
        return long.TryParse(json.Substring(start, i - start), out v) ? v : -1;
    }

    static int GetInt(string json, string key)
    {
        int k = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
        if (k < 0) return -1;
        int colon = json.IndexOf(':', k);
        if (colon < 0) return -1;
        int i = colon + 1;
        while (i < json.Length && (json[i] == ' ' || json[i] == '"')) i++;
        int start = i;
        while (i < json.Length && char.IsDigit(json[i])) i++;
        int v;
        return int.TryParse(json.Substring(start, i - start), out v) ? v : -1;
    }

    static string Err(string msg) { return "{\"ok\":false,\"error\":" + J(msg) + "}"; }

    static string Dump(long pinnedHwnd)
    {
        // A hung UIA provider blocks FindAll indefinitely — run the walk on a
        // worker and abandon it on timeout (the caller's watchdog recycles this
        // process if it keeps happening). CacheRequest.Activate is per-thread,
        // so the whole enumeration lives inside the task.
        var task = Task.Run<string>(() => DumpCore(pinnedHwnd));
        if (!task.Wait(DUMP_TIMEOUT_MS)) return Err("timeout — app not responding to accessibility queries");
        return task.Result;
    }

    static string DumpCore(long pinnedHwnd)
    {
        IntPtr frame = pinnedHwnd > 0 ? new IntPtr(pinnedHwnd) : GetForegroundWindow();
        if (frame == IntPtr.Zero) return Err("no foreground window");
        // UWP: resolve an ApplicationFrameHost frame to its real CoreWindow.
        IntPtr hwnd = ResolveContentWindow(frame);
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);

        AutomationElement root = AutomationElement.FromHandle(hwnd);
        AutomationElementCollection found;
        using (BuildCacheRequest().Activate())
        {
            found = root.FindAll(TreeScope.Descendants, InteractiveCondition);
        }

        Rect wr = root.Current.BoundingRectangle;
        string title = root.Current.Name ?? "";

        int count = Math.Min(found.Count, MAX_ELEMENTS);
        var kept = new List<AutomationElement>(count);
        var sb = new StringBuilder(16384);
        sb.Append("{\"ok\":true,\"window\":{\"title\":").Append(J(title))
          .Append(",\"hwnd\":").Append(hwnd.ToInt64())
          .Append(",\"pid\":").Append(pid)
          .Append(",\"rect\":[").Append(N(wr.Left)).Append(',').Append(N(wr.Top))
          .Append(',').Append(N(wr.Right)).Append(',').Append(N(wr.Bottom))
          .Append("]},\"elements\":[");

        bool first = true;
        for (int i = 0; i < count; i++)
        {
            AutomationElement el = found[i];
            Rect r;
            string name, type;
            bool invoke, value, select, focusable;
            try
            {
                r = el.Cached.BoundingRectangle;
                name = el.Cached.Name ?? "";
                type = el.Cached.ControlType.ProgrammaticName.Replace("ControlType.", "");
                object p;
                invoke = el.TryGetCachedPattern(InvokePattern.Pattern, out p)
                      || el.TryGetCachedPattern(TogglePattern.Pattern, out p);
                select = el.TryGetCachedPattern(SelectionItemPattern.Pattern, out p);
                value = el.TryGetCachedPattern(ValuePattern.Pattern, out p);
                focusable = (bool)el.GetCachedPropertyValue(AutomationElement.IsKeyboardFocusableProperty);
            }
            catch (ElementNotAvailableException) { continue; }
            catch (COMException) { continue; }
            if (r.Width <= 0 || r.Height <= 0) continue;
            // Text elements are context: keep only if labeled; never invokable.
            if (type == "Text" && name.Length == 0) continue;

            int id = kept.Count;
            kept.Add(el);
            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"id\":").Append(id)
              .Append(",\"name\":").Append(J(name.Length > 120 ? name.Substring(0, 120) : name))
              .Append(",\"type\":").Append(J(type))
              .Append(",\"rect\":[").Append(N(r.Left)).Append(',').Append(N(r.Top))
              .Append(',').Append(N(r.Right)).Append(',').Append(N(r.Bottom)).Append(']')
              .Append(",\"invoke\":").Append(invoke ? "true" : "false")
              .Append(",\"select\":").Append(select ? "true" : "false")
              .Append(",\"value\":").Append(value ? "true" : "false")
              .Append(",\"focusable\":").Append(focusable ? "true" : "false")
              .Append('}');
        }
        sb.Append("]}");

        lastElements = kept.ToArray();
        lastHwnd = hwnd;
        return sb.ToString();
    }

    /**
     * Visible top-level application windows (real ones — has a title, is not a
     * tool window, not owned). Lets the agent find and focus a just-launched
     * app when GetForegroundWindow is empty (foreground-lock after a
     * background process launches something).
     */
    static string Windows()
    {
        var sb = new StringBuilder("{\"ok\":true,\"windows\":[");
        bool first = true;
        EnumWindows((hwnd, l) =>
        {
            if (!IsWindowVisible(hwnd)) return true;
            if (GetWindow(hwnd, GW_OWNER) != IntPtr.Zero) return true; // owned popup
            if ((GetWindowLong(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true;
            int len = GetWindowTextLength(hwnd);
            if (len <= 0) return true;
            var title = new StringBuilder(len + 1);
            GetWindowText(hwnd, title, title.Capacity);
            string t = title.ToString();
            if (t.Length == 0) return true;
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"hwnd\":").Append(hwnd.ToInt64())
              .Append(",\"pid\":").Append(pid)
              .Append(",\"title\":").Append(J(t)).Append('}');
            return true;
        }, IntPtr.Zero);
        sb.Append("]}");
        return sb.ToString();
    }

    static AutomationElement ById(int id)
    {
        if (id < 0 || id >= lastElements.Length) return null;
        return lastElements[id];
    }

    /**
     * Programmatic activation ladder (UFO controller.py's order): Invoke for
     * buttons/links, Toggle for checkboxes, SelectionItem for list rows. Falls
     * through with ok:false so the caller can do a physical click instead.
     */
    static string Invoke(int id)
    {
        var el = ById(id);
        if (el == null) return Err("unknown id " + id);
        try
        {
            object p;
            if (el.TryGetCurrentPattern(InvokePattern.Pattern, out p))
            {
                ((InvokePattern)p).Invoke();
                return "{\"ok\":true,\"via\":\"invoke\"}";
            }
            if (el.TryGetCurrentPattern(TogglePattern.Pattern, out p))
            {
                ((TogglePattern)p).Toggle();
                return "{\"ok\":true,\"via\":\"toggle\"}";
            }
            if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p))
            {
                ((SelectionItemPattern)p).Select();
                return "{\"ok\":true,\"via\":\"select\"}";
            }
            return Err("element supports no activation pattern");
        }
        catch (ElementNotAvailableException) { return Err("element gone — re-dump"); }
        catch (Exception e) { return Err(e.Message); }
    }

    static string SetValue(int id, string text)
    {
        var el = ById(id);
        if (el == null) return Err("unknown id " + id);
        try
        {
            try { el.SetFocus(); } catch { }
            object p;
            if (el.TryGetCurrentPattern(ValuePattern.Pattern, out p))
            {
                ((ValuePattern)p).SetValue(text ?? "");
                return "{\"ok\":true}";
            }
            return Err("element does not support setvalue");
        }
        catch (ElementNotAvailableException) { return Err("element gone — re-dump"); }
        catch (Exception e) { return Err(e.Message); }
    }

    static string Focus(int id)
    {
        var el = ById(id);
        if (el == null) return Err("unknown id " + id);
        try { el.SetFocus(); return "{\"ok\":true}"; }
        catch (ElementNotAvailableException) { return Err("element gone — re-dump"); }
        catch (Exception e) { return Err(e.Message); }
    }

    [STAThread]
    static void Main()
    {
        try { SetProcessDpiAwarenessContext(DPI_PER_MONITOR_V2); } catch { }
        var stdout = Console.Out;
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            string cmd = GetStr(line, "cmd") ?? "";
            string resp;
            try
            {
                switch (cmd)
                {
                    case "ping": resp = "{\"ok\":true,\"pong\":true}"; break;
                    case "windows": resp = Windows(); break;
                    case "dump": resp = Dump(GetLong(line, "hwnd")); break;
                    case "invoke": resp = Invoke(GetInt(line, "id")); break;
                    case "setvalue": resp = SetValue(GetInt(line, "id"), GetStr(line, "text")); break;
                    case "focus": resp = Focus(GetInt(line, "id")); break;
                    default: resp = Err("unknown cmd " + cmd); break;
                }
            }
            catch (Exception e) { resp = Err(e.GetType().Name + ": " + e.Message); }
            stdout.WriteLine(resp);
            stdout.Flush();
        }
    }
}
