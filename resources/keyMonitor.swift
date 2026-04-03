#!/usr/bin/env swift
// Clarity Scribe — Global Key Monitor
// Monitors a single key (regular or modifier) for press/release via CGEventTap.
// Usage: keyMonitor <keyCode> [modifier]
//   keyCode: macOS virtual key code (e.g., 63 for fn/Globe, 49 for Space)
//   modifier: optional flag name for modifier-only keys ("fn", "control", "option", "shift", "command")
// Output: prints "KEY_DOWN" / "KEY_UP" lines to stdout.

import Foundation
import CoreGraphics

guard CommandLine.arguments.count >= 2,
      let code = UInt16(CommandLine.arguments[1]) else {
    fputs("Usage: keyMonitor <keyCode> [modifier]\n", stderr)
    exit(1)
}

let modName = CommandLine.arguments.count >= 3 ? CommandLine.arguments[2].lowercased() : nil

// Store config in globals so the C callback can access them without capturing
var gTargetKeyCode: UInt16 = code
var gIsFnKey: Bool = modName == "fn"
var gIsModifierKey: Bool = modName != nil
var gIsKeyDown: Bool = false

var gModifierFlag: UInt64 = 0
switch modName {
case "control":  gModifierFlag = CGEventFlags.maskControl.rawValue
case "option":   gModifierFlag = CGEventFlags.maskAlternate.rawValue
case "shift":    gModifierFlag = CGEventFlags.maskShift.rawValue
case "command":  gModifierFlag = CGEventFlags.maskCommand.rawValue
default:         gModifierFlag = 0
}

// Flush stdout after every write
setbuf(stdout, nil)

let eventMask: CGEventMask = {
    if gIsModifierKey {
        return (1 << CGEventType.flagsChanged.rawValue)
    } else {
        return (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
    }
}()

// Top-level function — no captures, safe as C function pointer
func eventCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {

    // If the tap is disabled by the system, re-enable it
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let refcon = refcon {
            let tap = Unmanaged<CFMachPort>.fromOpaque(refcon).takeUnretainedValue()
            CGEvent.tapEnable(tap: tap, enable: true)
        }
        return Unmanaged.passRetained(event)
    }

    if gIsModifierKey {
        let flags = event.flags

        if gIsFnKey {
            // fn/Globe key: check the secondaryFn flag (bit 23, value 0x800000)
            let fnPressed = flags.rawValue & UInt64(0x800000) != 0
            if fnPressed && !gIsKeyDown {
                gIsKeyDown = true
                print("KEY_DOWN")
            } else if !fnPressed && gIsKeyDown {
                gIsKeyDown = false
                print("KEY_UP")
            }
        } else if gModifierFlag != 0 {
            let pressed = flags.rawValue & gModifierFlag != 0
            if pressed && !gIsKeyDown {
                gIsKeyDown = true
                print("KEY_DOWN")
            } else if !pressed && gIsKeyDown {
                gIsKeyDown = false
                print("KEY_UP")
            }
        }
    } else {
        // Regular key — check keyDown / keyUp
        let keyCode = UInt16(event.getIntegerValueField(.keyboardEventKeycode))
        if keyCode == gTargetKeyCode {
            if type == .keyDown && !gIsKeyDown {
                gIsKeyDown = true
                print("KEY_DOWN")
            } else if type == .keyUp && gIsKeyDown {
                gIsKeyDown = false
                print("KEY_UP")
            }
        }
    }

    return Unmanaged.passRetained(event)
}

// Create an event tap at the session level (requires Accessibility permissions)
guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: eventMask,
    callback: eventCallback,
    userInfo: nil
) else {
    fputs("ERROR: Failed to create event tap. Grant Accessibility permissions.\n", stderr)
    exit(1)
}

// Pass tap ref back via enable (no userInfo needed since we use globals)
let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)

// Signal ready
print("READY")

// Run forever
CFRunLoopRun()
