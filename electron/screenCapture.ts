/**
 * Screen capture for agent mode — full-resolution primary-display screenshots.
 *
 * Uses Electron's desktopCapturer with thumbnailSize set to the display's
 * PHYSICAL pixel size (logical size × scaleFactor) so the "thumbnail" IS the
 * screenshot. Coordinates everywhere downstream (OmniParser bboxes → click
 * targets) are therefore in physical pixels of this capture.
 */

import { desktopCapturer, screen } from 'electron';

export interface ScreenShot {
    pngBase64: string;
    /** Physical pixel dimensions of the capture. */
    width: number;
    height: number;
}

export async function captureScreen(): Promise<ScreenShot> {
    const primary = screen.getPrimaryDisplay();
    const physical = {
        width: Math.round(primary.size.width * primary.scaleFactor),
        height: Math.round(primary.size.height * primary.scaleFactor),
    };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: physical });
    if (sources.length === 0) throw new Error('No screen sources available');
    const source = sources.find(s => s.display_id === String(primary.id)) ?? sources[0];
    const image = source.thumbnail;
    if (image.isEmpty()) throw new Error('Screen capture returned an empty image');
    const size = image.getSize();
    return { pngBase64: image.toPNG().toString('base64'), width: size.width, height: size.height };
}

/**
 * Capture only a window's region (physical screen pixels, e.g. a UIA window
 * rect) — scopes the vision fallback to the app being driven, so the model
 * never sees (or clicks) the desktop around it.
 */
export async function captureScreenRegion(rect: [number, number, number, number]): Promise<ScreenShot> {
    const primary = screen.getPrimaryDisplay();
    const physical = {
        width: Math.round(primary.size.width * primary.scaleFactor),
        height: Math.round(primary.size.height * primary.scaleFactor),
    };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: physical });
    if (sources.length === 0) throw new Error('No screen sources available');
    const source = sources.find(s => s.display_id === String(primary.id)) ?? sources[0];
    const full = source.thumbnail;
    if (full.isEmpty()) throw new Error('Screen capture returned an empty image');
    const size = full.getSize();
    const x = Math.max(0, Math.round(rect[0]));
    const y = Math.max(0, Math.round(rect[1]));
    const w = Math.min(size.width - x, Math.round(rect[2] - rect[0]));
    const h = Math.min(size.height - y, Math.round(rect[3] - rect[1]));
    if (w <= 0 || h <= 0) throw new Error('Window region is off-screen');
    const cropped = full.crop({ x, y, width: w, height: h });
    return { pngBase64: cropped.toPNG().toString('base64'), width: w, height: h };
}
