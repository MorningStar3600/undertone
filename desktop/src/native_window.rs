//! UI-thread-only operations on a borrowed GPUI window. Never retain or send a raw HWND.
use gpui::Window;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use undertone_desktop::ambience::Visibility;
use windows::{
    Win32::{
        Foundation::HWND,
        Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute},
        UI::WindowsAndMessaging::{
            HWND_NOTOPMOST, HWND_TOPMOST, IsIconic, IsWindowVisible, SPI_GETCLIENTAREAANIMATION,
            SW_RESTORE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE,
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, SetWindowPos, ShowWindow, SystemParametersInfoW,
        },
    },
    core::BOOL,
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

/// Whether anything of this window can be seen: not minimized, shown, and not cloaked by DWM
/// (another virtual desktop). Read-only queries; an unknown window counts as visible.
pub fn visibility(window: &Window) -> Visibility {
    let Ok(hwnd) = hwnd(window) else {
        return Visibility::default();
    };
    // SAFETY: read-only queries on the borrowed, live UI-thread window; the out pointer is a
    // local u32 of the declared size.
    unsafe {
        let mut cloaked = 0u32;
        Visibility {
            minimized: IsIconic(hwnd).as_bool(),
            hidden: !IsWindowVisible(hwnd).as_bool(),
            cloaked: DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                (&mut cloaked as *mut u32).cast(),
                size_of::<u32>() as u32,
            )
            .is_ok()
                && cloaked != 0,
        }
    }
}

/// Windows "Show animations in Windows" (SPI_GETCLIENTAREAANIMATION). Read only; never changed.
pub fn system_animations() -> bool {
    let mut enabled = BOOL(1);
    // SAFETY: SPI_GETCLIENTAREAANIMATION writes one BOOL to the provided local.
    unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            Some((&mut enabled as *mut BOOL).cast()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    }
    .map(|_| enabled.as_bool())
    .unwrap_or(true)
}
