//! UI-thread-only operations on a borrowed GPUI window. Never retain or send a raw HWND.
use gpui::Window;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{
        HWND_NOTOPMOST, HWND_TOPMOST, SW_RESTORE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER,
        SWP_NOSIZE, SetWindowPos, ShowWindow,
    },
};

fn hwnd(window: &Window) -> anyhow::Result<HWND> {
    match HasWindowHandle::window_handle(window)?.as_raw() {
        RawWindowHandle::Win32(handle) => Ok(HWND(handle.hwnd.get() as *mut _)),
        _ => anyhow::bail!("Windows window required"),
    }
}

pub fn pin(window: &Window, pinned: bool) -> anyhow::Result<()> {
    let hwnd = hwnd(window)?;
    // SAFETY: the borrowed window is alive on its GPUI UI thread for the whole call.
    // No activation, geometry change, retained handle, or operation on another application's HWND.
    unsafe {
        SetWindowPos(
            hwnd,
            Some(if pinned { HWND_TOPMOST } else { HWND_NOTOPMOST }),
            0,
            0,
            0,
            0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOOWNERZORDER,
        )?;
    }
    Ok(())
}

pub fn restore(window: &Window) -> anyhow::Result<()> {
    // Explicit user action only. Notifications/art/progress updates never call this.
    let hwnd = hwnd(window)?;
    // SAFETY: same borrowed UI-thread window lifetime as pin(). Return is prior visibility, not error.
    unsafe {
        let _ = ShowWindow(hwnd, SW_RESTORE);
    }
    window.activate_window();
    Ok(())
}
