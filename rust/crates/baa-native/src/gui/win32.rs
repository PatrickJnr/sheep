//! The Windows backend: real windows, real controls, real messages.
//!
//! The Win32 functions are declared here rather than pulled in from a bindings
//! crate. There are about thirty of them, they are a stable operating-system
//! ABI that has not changed since the 1990s, and Baa ships no dependencies.
//! A crate would be more code downloaded, not less code maintained.
//!
//! Two decisions are worth knowing about before reading the rest.
//!
//! **Nothing calls Baa from inside a window procedure.** A `WndProc` is called
//! by Windows, from inside `DispatchMessageW`, at a point where the
//! interpreter is already borrowed by whatever asked for the message. Running
//! a handler there would be re-entrancy, and in Rust it would be a borrow that
//! cannot be proven safe. So the procedure only records what happened, and the
//! loop in `main.rs` drains those events and calls handlers afterwards, when
//! nothing else is running.
//!
//! **The window procedure reaches the UI through a thread-local pointer**,
//! which is set for exactly as long as a message is being dispatched. That is
//! the standard shape of this problem, and the pointer is null at every other
//! moment, so a stray message cannot find a stale tree.

#![allow(non_snake_case)]
// HWND, WPARAM, WNDCLASSEXW and friends keep the spellings the Windows
// documentation uses. Renaming them to satisfy a naming lint would make every
// declaration here harder to check against the page that defines it, which is
// the only way to be sure an `extern` block is right.
#![allow(clippy::upper_case_acronyms)]

use std::cell::Cell;
use std::collections::HashMap;

use super::{Align, Backend, EventKind, Kind, Ui};

type HWND = isize;
type HINSTANCE = isize;
type HMENU = isize;
type HICON = isize;
type HCURSOR = isize;
type HBRUSH = isize;
type HFONT = isize;
type WPARAM = usize;
type LPARAM = isize;
type LRESULT = isize;
type WndProcFn = unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT;

#[repr(C)]
struct WNDCLASSEXW {
    cbSize: u32,
    style: u32,
    lpfnWndProc: Option<WndProcFn>,
    cbClsExtra: i32,
    cbWndExtra: i32,
    hInstance: HINSTANCE,
    hIcon: HICON,
    hCursor: HCURSOR,
    hbrBackground: HBRUSH,
    lpszMenuName: *const u16,
    lpszClassName: *const u16,
    hIconSm: HICON,
}

#[repr(C)]
#[derive(Default)]
struct POINT {
    x: i32,
    y: i32,
}

#[repr(C)]
#[derive(Default)]
struct MSG {
    hwnd: HWND,
    message: u32,
    wParam: WPARAM,
    lParam: LPARAM,
    time: u32,
    pt: POINT,
    private: u32,
}

#[repr(C)]
#[derive(Default)]
struct RECT {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
struct OPENFILENAMEW {
    lStructSize: u32,
    hwndOwner: HWND,
    hInstance: HINSTANCE,
    lpstrFilter: *const u16,
    lpstrCustomFilter: *mut u16,
    nMaxCustFilter: u32,
    nFilterIndex: u32,
    lpstrFile: *mut u16,
    nMaxFile: u32,
    lpstrFileTitle: *mut u16,
    nMaxFileTitle: u32,
    lpstrInitialDir: *const u16,
    lpstrTitle: *const u16,
    Flags: u32,
    nFileOffset: u16,
    nFileExtension: u16,
    lpstrDefExt: *const u16,
    lCustData: LPARAM,
    lpfnHook: usize,
    lpTemplateName: *const u16,
    pvReserved: usize,
    dwReserved: u32,
    FlagsEx: u32,
}

#[link(name = "user32")]
#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> HINSTANCE;
    fn RegisterClassExW(class: *const WNDCLASSEXW) -> u16;
    fn LoadCursorW(instance: HINSTANCE, name: usize) -> HCURSOR;
    fn CreateWindowExW(
        exStyle: u32,
        className: *const u16,
        windowName: *const u16,
        style: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        parent: HWND,
        menu: HMENU,
        instance: HINSTANCE,
        param: *const u8,
    ) -> HWND;
    fn DefWindowProcW(hwnd: HWND, message: u32, wParam: WPARAM, lParam: LPARAM) -> LRESULT;
    fn ShowWindow(hwnd: HWND, command: i32) -> i32;
    fn UpdateWindow(hwnd: HWND) -> i32;
    fn DestroyWindow(hwnd: HWND) -> i32;
    fn GetMessageW(message: *mut MSG, hwnd: HWND, min: u32, max: u32) -> i32;
    fn TranslateMessage(message: *const MSG) -> i32;
    fn DispatchMessageW(message: *const MSG) -> LRESULT;
    fn PostQuitMessage(code: i32);
    fn MoveWindow(hwnd: HWND, x: i32, y: i32, width: i32, height: i32, repaint: i32) -> i32;
    fn SetWindowTextW(hwnd: HWND, text: *const u16) -> i32;
    fn GetWindowTextW(hwnd: HWND, text: *mut u16, count: i32) -> i32;
    fn GetWindowTextLengthW(hwnd: HWND) -> i32;
    fn SendMessageW(hwnd: HWND, message: u32, wParam: WPARAM, lParam: LPARAM) -> LRESULT;
    fn GetClientRect(hwnd: HWND, rect: *mut RECT) -> i32;
    fn AdjustWindowRect(rect: *mut RECT, style: u32, menu: i32) -> i32;
    fn SetWindowLongPtrW(hwnd: HWND, index: i32, value: isize) -> isize;
    fn GetWindowLongPtrW(hwnd: HWND, index: i32) -> isize;
    fn EnableWindow(hwnd: HWND, enable: i32) -> i32;
    fn MessageBoxW(hwnd: HWND, text: *const u16, caption: *const u16, kind: u32) -> i32;
    fn SetFocus(hwnd: HWND) -> HWND;
    fn OpenClipboard(hwnd: HWND) -> i32;
    fn CloseClipboard() -> i32;
    fn EmptyClipboard() -> i32;
    fn GetClipboardData(format: u32) -> isize;
    fn SetClipboardData(format: u32, handle: isize) -> isize;
    fn GetDpiForWindow(hwnd: HWND) -> u32;
    fn SetProcessDpiAwarenessContext(context: isize) -> i32;
    fn CreateMenu() -> HMENU;
    fn CreatePopupMenu() -> HMENU;
    fn AppendMenuW(menu: HMENU, flags: u32, id: usize, text: *const u16) -> i32;
    fn SetMenu(hwnd: HWND, menu: HMENU) -> i32;
    fn DrawMenuBar(hwnd: HWND) -> i32;
}

#[link(name = "gdi32")]
extern "system" {
    fn CreateFontW(
        height: i32,
        width: i32,
        escapement: i32,
        orientation: i32,
        weight: i32,
        italic: u32,
        underline: u32,
        strikeOut: u32,
        charSet: u32,
        outPrecision: u32,
        clipPrecision: u32,
        quality: u32,
        pitchAndFamily: u32,
        faceName: *const u16,
    ) -> HFONT;
    fn DeleteObject(object: isize) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn GlobalAlloc(flags: u32, bytes: usize) -> isize;
    fn GlobalLock(handle: isize) -> *mut u8;
    fn GlobalUnlock(handle: isize) -> i32;
}

#[link(name = "comdlg32")]
extern "system" {
    fn GetOpenFileNameW(options: *mut OPENFILENAMEW) -> i32;
    fn GetSaveFileNameW(options: *mut OPENFILENAMEW) -> i32;
}

const WM_DESTROY: u32 = 0x0002;
const WM_SIZE: u32 = 0x0005;
const WM_CLOSE: u32 = 0x0010;
const WM_SETFONT: u32 = 0x0030;
const WM_COMMAND: u32 = 0x0111;
const WM_DPICHANGED: u32 = 0x02E0;

const BN_CLICKED: u16 = 0;
const EN_CHANGE: u16 = 0x0300;
const LBN_SELCHANGE: u16 = 1;

const LB_ADDSTRING: u32 = 0x0180;
const LB_RESETCONTENT: u32 = 0x0184;
const LB_SETCURSEL: u32 = 0x0186;
const LB_GETCURSEL: u32 = 0x0188;
const BM_GETCHECK: u32 = 0x00F0;
const BM_SETCHECK: u32 = 0x00F1;

const WS_CHILD: u32 = 0x4000_0000;
const WS_VISIBLE: u32 = 0x1000_0000;
const WS_OVERLAPPEDWINDOW: u32 = 0x00CF_0000;
const WS_VSCROLL: u32 = 0x0020_0000;
const WS_BORDER: u32 = 0x0080_0000;
const WS_TABSTOP: u32 = 0x0001_0000;
const ES_MULTILINE: u32 = 0x0004;
const ES_AUTOVSCROLL: u32 = 0x0040;
const ES_AUTOHSCROLL: u32 = 0x0080;
const ES_RIGHT: u32 = 0x0002;
const ES_CENTER: u32 = 0x0001;
const SS_RIGHT: u32 = 0x0002;
const SS_CENTER: u32 = 0x0001;
const SS_CENTERIMAGE: u32 = 0x0200;
const BS_AUTOCHECKBOX: u32 = 0x0003;
const LBS_NOTIFY: u32 = 0x0001;
const SW_SHOWNORMAL: i32 = 1;
const GWLP_USERDATA: i32 = -21;
const IDC_ARROW: usize = 32512;
const COLOR_WINDOW: isize = 5;
const CF_UNICODETEXT: u32 = 13;
const GMEM_MOVEABLE: u32 = 0x0002;
const MB_OK: u32 = 0x0000;
const MB_OKCANCEL: u32 = 0x0001;
const MB_YESNO: u32 = 0x0004;
const MB_ICONWARNING: u32 = 0x0030;
const MB_ICONINFORMATION: u32 = 0x0040;
const IDOK: i32 = 1;
const IDYES: i32 = 6;
const OFN_PATHMUSTEXIST: u32 = 0x0000_0800;
const OFN_FILEMUSTEXIST: u32 = 0x0000_1000;
const OFN_OVERWRITEPROMPT: u32 = 0x0000_0002;
const OFN_EXPLORER: u32 = 0x0008_0000;
const DPI_AWARENESS_PER_MONITOR_V2: isize = -4;
const MF_STRING: u32 = 0x0000;
const MF_POPUP: u32 = 0x0010;
const MF_SEPARATOR: u32 = 0x0800;
const MF_GRAYED: u32 = 0x0001;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn from_wide(buffer: &[u16]) -> String {
    let end = buffer.iter().position(|unit| *unit == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}

thread_local! {
    /// The tree, for as long as a message is being dispatched. Null otherwise.
    static ACTIVE: Cell<*mut Ui> = const { Cell::new(std::ptr::null_mut()) };
}

/// Runs `body` with the UI reachable from the window procedure.
fn with_active<T>(ui: &mut Ui, body: impl FnOnce() -> T) -> T {
    ACTIVE.with(|slot| slot.set(ui as *mut Ui));
    let outcome = body();
    ACTIVE.with(|slot| slot.set(std::ptr::null_mut()));
    outcome
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wParam: WPARAM, lParam: LPARAM) -> LRESULT {
    let pointer = ACTIVE.with(|slot| slot.get());
    if pointer.is_null() {
        return DefWindowProcW(hwnd, message, wParam, lParam);
    }
    let ui = &mut *pointer;

    match message {
        WM_COMMAND => {
            let control = (wParam & 0xffff) as u16;
            let notification = ((wParam >> 16) & 0xffff) as u16;
            if control > 0 {
                let widget = control as usize - 1;
                if let Some(target) = ui.get(widget) {
                    let kind = match (target.kind, notification) {
                        (Kind::Button, BN_CLICKED) => Some(EventKind::Click),
                        // A menu selection arrives as WM_COMMAND with a zero
                        // notification code and a null lParam, which is the
                        // same shape a button click has.
                        (Kind::MenuItem, 0) => Some(EventKind::Click),
                        (Kind::Checkbox, BN_CLICKED) => Some(EventKind::Toggle),
                        (Kind::Edit, EN_CHANGE) | (Kind::TextArea, EN_CHANGE) => Some(EventKind::Changed),
                        (Kind::List, LBN_SELCHANGE) => Some(EventKind::Select),
                        _ => None,
                    };
                    if let Some(kind) = kind {
                        // The control owns the truth about its own contents,
                        // so it is read back here rather than at handler time,
                        // when focus may have moved on.
                        read_back(ui, widget);
                        ui.push_event(widget, kind);
                    }
                }
            }
            0
        }
        WM_SIZE => {
            let id = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if id > 0 {
                let widget = id as usize - 1;
                let width = (lParam & 0xffff) as u16 as f64;
                let height = ((lParam >> 16) & 0xffff) as u16 as f64;
                let scale = dpi_scale(hwnd);
                ui.layout(widget, width / scale, height / scale);
                apply_layout(ui, widget, scale);
            }
            0
        }
        WM_DPICHANGED => {
            let id = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if id > 0 {
                let widget = id as usize - 1;
                let mut rect = RECT::default();
                GetClientRect(hwnd, &mut rect);
                let scale = dpi_scale(hwnd);
                ui.layout(widget, (rect.right - rect.left) as f64 / scale, (rect.bottom - rect.top) as f64 / scale);
                apply_layout(ui, widget, scale);
            }
            0
        }
        WM_CLOSE => {
            let id = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if id > 0 {
                ui.push_event(id as usize - 1, EventKind::Close);
            }
            // Not destroyed here: a handler may want to ask "save first?".
            // `barn.close` is what actually shuts a window.
            0
        }
        WM_DESTROY => {
            let id = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if id > 0 {
                if let Some(widget) = ui.get_mut(id as usize - 1) {
                    widget.handle = 0;
                }
            }
            ui.open = ui.open.saturating_sub(1);
            if ui.open == 0 {
                PostQuitMessage(0);
            }
            0
        }
        _ => DefWindowProcW(hwnd, message, wParam, lParam),
    }
}

/// Copies a control's own state back into the tree, so a Baa handler reading
/// `barn.text(field)` sees what the person typed.
unsafe fn read_back(ui: &mut Ui, widget: usize) {
    let Some(target) = ui.get(widget) else { return };
    let handle = target.handle as HWND;
    if handle == 0 {
        return;
    }
    match target.kind {
        Kind::Edit | Kind::TextArea => {
            let length = GetWindowTextLengthW(handle);
            let mut buffer = vec![0u16; length as usize + 1];
            GetWindowTextW(handle, buffer.as_mut_ptr(), buffer.len() as i32);
            let text = from_wide(&buffer);
            if let Some(target) = ui.get_mut(widget) {
                target.text = text;
            }
        }
        Kind::List => {
            let selected = SendMessageW(handle, LB_GETCURSEL, 0, 0);
            if let Some(target) = ui.get_mut(widget) {
                target.selected = selected as i64;
            }
        }
        Kind::Checkbox => {
            let checked = SendMessageW(handle, BM_GETCHECK, 0, 0) == 1;
            if let Some(target) = ui.get_mut(widget) {
                target.checked = checked;
            }
        }
        _ => {}
    }
}

fn dpi_scale(hwnd: HWND) -> f64 {
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 {
        1.0
    } else {
        dpi as f64 / 96.0
    }
}

/// Moves every realised control to where the layout put it.
unsafe fn apply_layout(ui: &mut Ui, window: usize, scale: f64) {
    let mut stack = vec![window];
    while let Some(id) = stack.pop() {
        let Some(widget) = ui.get(id) else { continue };
        stack.extend(widget.children.iter().copied());
        if id == window || widget.handle == 0 {
            continue;
        }
        let rect = widget.rect;
        MoveWindow(
            widget.handle as HWND,
            (rect.x * scale).round() as i32,
            (rect.y * scale).round() as i32,
            (rect.width * scale).round() as i32,
            (rect.height * scale).round() as i32,
            1,
        );
    }
}

pub struct Win32 {
    instance: HINSTANCE,
    class: Vec<u16>,
    registered: bool,
    fonts: HashMap<i64, HFONT>,
}

impl Default for Win32 {
    fn default() -> Win32 {
        Win32::new()
    }
}

impl Win32 {
    pub fn new() -> Win32 {
        unsafe {
            // Asking for per-monitor v2 before any window exists is what makes
            // text sharp on a scaled display instead of bitmap-stretched. It
            // fails harmlessly on Windows versions that predate it.
            SetProcessDpiAwarenessContext(DPI_AWARENESS_PER_MONITOR_V2);
        }
        Win32 {
            instance: unsafe { GetModuleHandleW(std::ptr::null()) },
            class: wide("BaaWindow"),
            registered: false,
            fonts: HashMap::new(),
        }
    }

    fn register(&mut self) {
        if self.registered {
            return;
        }
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: 0,
            lpfnWndProc: Some(window_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: self.instance,
            hIcon: 0,
            hCursor: unsafe { LoadCursorW(0, IDC_ARROW) },
            hbrBackground: COLOR_WINDOW + 1,
            lpszMenuName: std::ptr::null(),
            lpszClassName: self.class.as_ptr(),
            hIconSm: 0,
        };
        unsafe { RegisterClassExW(&class) };
        self.registered = true;
    }

    fn font(&mut self, size: f64, scale: f64) -> HFONT {
        let points = if size <= 0.0 { 9.0 } else { size };
        // Negative height asks for a character height rather than a cell
        // height, which is what makes a requested size match what is drawn.
        let height = -((points * scale * 96.0 / 72.0).round() as i32);
        let key = height as i64;
        if let Some(font) = self.fonts.get(&key) {
            return *font;
        }
        let face = wide("Segoe UI");
        let font = unsafe {
            CreateFontW(height, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, face.as_ptr())
        };
        self.fonts.insert(key, font);
        font
    }

    unsafe fn create_control(&mut self, ui: &mut Ui, id: usize, parent: HWND, scale: f64) {
        let widget = &ui.widgets[id];
        let (class, mut style, ex_style) = match widget.kind {
            Kind::Button => ("BUTTON", WS_TABSTOP, 0),
            Kind::Checkbox => ("BUTTON", WS_TABSTOP | BS_AUTOCHECKBOX, 0),
            Kind::Label => ("STATIC", SS_CENTERIMAGE, 0),
            Kind::Edit => ("EDIT", WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL, 0),
            Kind::TextArea => (
                "EDIT",
                WS_TABSTOP | WS_BORDER | WS_VSCROLL | ES_MULTILINE | ES_AUTOVSCROLL,
                0,
            ),
            Kind::List => ("LISTBOX", WS_TABSTOP | WS_BORDER | WS_VSCROLL | LBS_NOTIFY, 0),
            // Menus are built separately, onto the window's own menu bar.
            Kind::Menu | Kind::MenuItem | Kind::Separator => return,
            // Rows, columns and spacers are layout, not controls: they have no
            // window of their own, which is also why they cannot have a colour.
            _ => {
                let children = widget.children.clone();
                for child in children {
                    self.create_control(ui, child, parent, scale);
                }
                return;
            }
        };
        match widget.align {
            Align::Center => style |= if widget.kind == Kind::Label { SS_CENTER } else { ES_CENTER },
            Align::End => style |= if widget.kind == Kind::Label { SS_RIGHT } else { ES_RIGHT },
            Align::Start => {}
        }

        let class_name = wide(class);
        let text = wide(&widget.text);
        let rect = widget.rect;
        let font_size = widget.font_size;
        let handle = CreateWindowExW(
            ex_style,
            class_name.as_ptr(),
            text.as_ptr(),
            WS_CHILD | WS_VISIBLE | style,
            (rect.x * scale).round() as i32,
            (rect.y * scale).round() as i32,
            (rect.width * scale).round() as i32,
            (rect.height * scale).round() as i32,
            parent,
            // The control id is the widget index plus one, so `WM_COMMAND`
            // identifies the widget without a lookup table. Zero is reserved
            // by Windows, hence the offset.
            (id + 1) as HMENU,
            self.instance,
            std::ptr::null(),
        );
        let font = self.font(font_size, scale);
        SendMessageW(handle, WM_SETFONT, font as WPARAM, 1);

        let items = ui.widgets[id].items.clone();
        let selected = ui.widgets[id].selected;
        let checked = ui.widgets[id].checked;
        let enabled = ui.widgets[id].enabled;
        ui.widgets[id].handle = handle as usize;

        if ui.widgets[id].kind == Kind::List {
            for item in &items {
                let text = wide(item);
                SendMessageW(handle, LB_ADDSTRING, 0, text.as_ptr() as LPARAM);
            }
            if selected >= 0 {
                SendMessageW(handle, LB_SETCURSEL, selected as WPARAM, 0);
            }
        }
        if ui.widgets[id].kind == Kind::Checkbox && checked {
            SendMessageW(handle, BM_SETCHECK, 1, 0);
        }
        if !enabled {
            EnableWindow(handle, 0);
        }

        let children = ui.widgets[id].children.clone();
        for child in children {
            self.create_control(ui, child, parent, scale);
        }
    }
}

impl Backend for Win32 {
    fn create_window(&mut self, ui: &mut Ui, window: usize) -> Result<(), String> {
        self.register();
        let title = wide(&ui.widgets[window].text);
        let width = ui.widgets[window].width.unwrap_or(480.0);
        let height = ui.widgets[window].height.unwrap_or(360.0);

        // The size in the manifest is the space the application draws in, not
        // the space the frame takes: asking for 320x160 and getting 304x121 of
        // usable area is the kind of thing that makes a layout look wrong on
        // one machine and right on another. `AdjustWindowRect` converts.
        let mut frame = RECT { left: 0, top: 0, right: width as i32, bottom: height as i32 };
        unsafe { AdjustWindowRect(&mut frame, WS_OVERLAPPEDWINDOW, 0) };
        let frame_width = frame.right - frame.left;
        let frame_height = frame.bottom - frame.top;

        let hwnd = unsafe {
            CreateWindowExW(
                0,
                self.class.as_ptr(),
                title.as_ptr(),
                WS_OVERLAPPEDWINDOW,
                // CW_USEDEFAULT, twice: let Windows place the window.
                i32::MIN,
                i32::MIN,
                frame_width,
                frame_height,
                0,
                0,
                self.instance,
                std::ptr::null(),
            )
        };
        if hwnd == 0 {
            return Err("Windows refused to create the window".to_string());
        }
        ui.widgets[window].handle = hwnd as usize;
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, (window + 1) as isize) };

        let scale = dpi_scale(hwnd);
        // The requested size is a client size, and the frame is drawn outside
        // it, so the window is resized to make the client area come out right.
        let mut client = RECT::default();
        unsafe { GetClientRect(hwnd, &mut client) };
        ui.layout(window, (client.right - client.left) as f64 / scale, (client.bottom - client.top) as f64 / scale);

        let children = ui.widgets[window].children.clone();
        unsafe {
            for child in children {
                self.create_control(ui, child, hwnd, scale);
            }
            build_menu(ui, window, hwnd);
            ShowWindow(hwnd, SW_SHOWNORMAL);
            UpdateWindow(hwnd);
        }
        Ok(())
    }

    fn sync(&mut self, ui: &mut Ui) {
        let count = ui.widgets.len();
        for id in 0..count {
            if !ui.widgets[id].dirty {
                continue;
            }
            ui.widgets[id].dirty = false;
            let handle = ui.widgets[id].handle as HWND;
            if handle == 0 {
                continue;
            }
            let widget = &ui.widgets[id];
            let text = wide(&widget.text);
            let kind = widget.kind;
            let enabled = widget.enabled;
            let checked = widget.checked;
            let selected = widget.selected;
            let items = widget.items.clone();
            unsafe {
                SetWindowTextW(handle, text.as_ptr());
                EnableWindow(handle, i32::from(enabled));
                if kind == Kind::Checkbox {
                    SendMessageW(handle, BM_SETCHECK, usize::from(checked), 0);
                }
                if kind == Kind::List {
                    SendMessageW(handle, LB_RESETCONTENT, 0, 0);
                    for item in &items {
                        let item = wide(item);
                        SendMessageW(handle, LB_ADDSTRING, 0, item.as_ptr() as LPARAM);
                    }
                    SendMessageW(handle, LB_SETCURSEL, selected.max(-1) as WPARAM, 0);
                }
            }
        }
    }

    fn pump(&mut self, ui: &mut Ui) -> bool {
        let mut message = MSG::default();
        with_active(ui, || unsafe {
            let outcome = GetMessageW(&mut message, 0, 0, 0);
            if outcome <= 0 {
                return false;
            }
            TranslateMessage(&message);
            DispatchMessageW(&message);
            true
        })
    }

    fn close(&mut self, ui: &mut Ui, window: usize) {
        let handle = ui.widgets.get(window).map(|widget| widget.handle).unwrap_or(0);
        if handle != 0 {
            with_active(ui, || unsafe {
                DestroyWindow(handle as HWND);
            });
        }
    }

    fn message(&mut self, ui: &Ui, window: usize, title: &str, text: &str, kind: &str) -> bool {
        let owner = ui.widgets.get(window).map(|widget| widget.handle as HWND).unwrap_or(0);
        let flags = match kind {
            "confirm" => MB_OKCANCEL | MB_ICONWARNING,
            "ask" => MB_YESNO | MB_ICONWARNING,
            _ => MB_OK | MB_ICONINFORMATION,
        };
        let text = wide(text);
        let caption = wide(title);
        let answer = unsafe { MessageBoxW(owner, text.as_ptr(), caption.as_ptr(), flags) };
        answer == IDOK || answer == IDYES
    }

    fn file_dialog(&mut self, ui: &Ui, window: usize, save: bool, filter: &str) -> Option<String> {
        let owner = ui.widgets.get(window).map(|widget| widget.handle as HWND).unwrap_or(0);
        let mut file = vec![0u16; 4096];

        // A filter is a run of null-terminated pairs ending in a double null,
        // which is why it cannot be built with `wide`.
        let mut filter_buffer: Vec<u16> = Vec::new();
        for part in filter.split('|') {
            filter_buffer.extend(part.encode_utf16());
            filter_buffer.push(0);
        }
        filter_buffer.push(0);

        let mut options = OPENFILENAMEW {
            lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
            hwndOwner: owner,
            hInstance: 0,
            lpstrFilter: filter_buffer.as_ptr(),
            lpstrCustomFilter: std::ptr::null_mut(),
            nMaxCustFilter: 0,
            nFilterIndex: 1,
            lpstrFile: file.as_mut_ptr(),
            nMaxFile: file.len() as u32,
            lpstrFileTitle: std::ptr::null_mut(),
            nMaxFileTitle: 0,
            lpstrInitialDir: std::ptr::null(),
            lpstrTitle: std::ptr::null(),
            Flags: OFN_EXPLORER
                | OFN_PATHMUSTEXIST
                | if save { OFN_OVERWRITEPROMPT } else { OFN_FILEMUSTEXIST },
            nFileOffset: 0,
            nFileExtension: 0,
            lpstrDefExt: std::ptr::null(),
            lCustData: 0,
            lpfnHook: 0,
            lpTemplateName: std::ptr::null(),
            pvReserved: 0,
            dwReserved: 0,
            FlagsEx: 0,
        };
        let chosen = unsafe {
            if save {
                GetSaveFileNameW(&mut options)
            } else {
                GetOpenFileNameW(&mut options)
            }
        };
        if chosen == 0 {
            return None;
        }
        Some(from_wide(&file))
    }

    fn clipboard_get(&mut self) -> Option<String> {
        unsafe {
            if OpenClipboard(0) == 0 {
                return None;
            }
            let handle = GetClipboardData(CF_UNICODETEXT);
            if handle == 0 {
                CloseClipboard();
                return None;
            }
            let pointer = GlobalLock(handle) as *const u16;
            if pointer.is_null() {
                CloseClipboard();
                return None;
            }
            let mut length = 0usize;
            while *pointer.add(length) != 0 {
                length += 1;
            }
            let text = String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length));
            GlobalUnlock(handle);
            CloseClipboard();
            Some(text)
        }
    }

    fn clipboard_set(&mut self, text: &str) -> bool {
        let units = wide(text);
        unsafe {
            if OpenClipboard(0) == 0 {
                return false;
            }
            EmptyClipboard();
            let bytes = units.len() * 2;
            let handle = GlobalAlloc(GMEM_MOVEABLE, bytes);
            if handle == 0 {
                CloseClipboard();
                return false;
            }
            let pointer = GlobalLock(handle);
            if pointer.is_null() {
                CloseClipboard();
                return false;
            }
            std::ptr::copy_nonoverlapping(units.as_ptr() as *const u8, pointer, bytes);
            GlobalUnlock(handle);
            // Ownership passes to the clipboard here; freeing it would be a
            // double free the next time anything pasted.
            SetClipboardData(CF_UNICODETEXT, handle);
            CloseClipboard();
            true
        }
    }
}

impl Drop for Win32 {
    fn drop(&mut self) {
        for font in self.fonts.values() {
            unsafe { DeleteObject(*font) };
        }
    }
}

/// Builds the window's menu bar from the `Menu` widgets under it.
///
/// A menu item's command id is its widget index plus one, exactly as a
/// control's is, so `WM_COMMAND` needs no second lookup table and a menu item
/// and a button reach the same handler code.
unsafe fn build_menu(ui: &Ui, window: usize, hwnd: HWND) {
    let menus: Vec<usize> = ui.widgets[window]
        .children
        .iter()
        .copied()
        .filter(|id| ui.widgets[*id].kind == Kind::Menu)
        .collect();
    if menus.is_empty() {
        return;
    }
    let bar = CreateMenu();
    for menu in menus {
        let popup = CreatePopupMenu();
        for item in ui.widgets[menu].children.iter().copied() {
            let widget = &ui.widgets[item];
            match widget.kind {
                Kind::Separator => {
                    AppendMenuW(popup, MF_SEPARATOR, 0, std::ptr::null());
                }
                Kind::MenuItem => {
                    let text = wide(&widget.text);
                    let flags = MF_STRING | if widget.enabled { 0 } else { MF_GRAYED };
                    AppendMenuW(popup, flags, item + 1, text.as_ptr());
                }
                _ => {}
            }
        }
        let title = wide(&ui.widgets[menu].text);
        AppendMenuW(bar, MF_POPUP, popup as usize, title.as_ptr());
    }
    SetMenu(hwnd, bar);
    DrawMenuBar(hwnd);
}

/// Puts keyboard focus on a widget, used by `barn.focus`.
pub fn focus(ui: &Ui, widget: usize) {
    if let Some(target) = ui.get(widget) {
        if target.handle != 0 {
            unsafe { SetFocus(target.handle as HWND) };
        }
    }
}
