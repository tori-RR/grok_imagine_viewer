//! Native gallery-root dialogs. Must run on the UI thread.
use std::path::PathBuf;

#[cfg(windows)]
use windows::Win32::Foundation::HWND;

#[cfg(windows)]
const HRESULT_CANCELLED: i32 = 0x8007_04C7_u32 as i32;

#[cfg(windows)]
pub(crate) fn pick_existing_folder(owner: HWND) -> Result<Option<PathBuf>, String> {
    unsafe {
        show_file_dialog(
            owner,
            &windows::Win32::UI::Shell::FileOpenDialog,
            windows::Win32::UI::Shell::FOS_PICKFOLDERS
                | windows::Win32::UI::Shell::FOS_FORCEFILESYSTEM
                | windows::Win32::UI::Shell::FOS_PATHMUSTEXIST
                | windows::Win32::UI::Shell::FOS_NOCHANGEDIR,
            windows::core::w!("选择图库根目录"),
            None,
            None,
        )
    }
}

#[cfg(windows)]
pub(crate) fn pick_new_library_path(owner: HWND) -> Result<Option<PathBuf>, String> {
    unsafe {
        show_file_dialog(
            owner,
            &windows::Win32::UI::Shell::FileSaveDialog,
            windows::Win32::UI::Shell::FOS_FORCEFILESYSTEM
                | windows::Win32::UI::Shell::FOS_NOCHANGEDIR
                | windows::Win32::UI::Shell::FOS_DONTADDTORECENT,
            windows::core::w!("新建库文件夹"),
            Some(windows::core::w!("创建")),
            Some(windows::core::w!("imagine_library")),
        )
    }
}

#[cfg(not(windows))]
pub(crate) fn pick_existing_folder(_owner: ()) -> Result<Option<PathBuf>, String> {
    Err("当前平台没有本机目录对话框。".into())
}

#[cfg(not(windows))]
pub(crate) fn pick_new_library_path(_owner: ()) -> Result<Option<PathBuf>, String> {
    Err("当前平台没有本机目录对话框。".into())
}

#[cfg(windows)]
unsafe fn show_file_dialog(
    owner: HWND,
    clsid: &windows::core::GUID,
    options: windows::Win32::UI::Shell::FILEOPENDIALOGOPTIONS,
    title: windows::core::PCWSTR,
    ok_label: Option<windows::core::PCWSTR>,
    file_name: Option<windows::core::PCWSTR>,
) -> Result<Option<PathBuf>, String> {
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        FOLDERID_ComputerFolder, FOLDERID_Desktop, FOLDERID_NetworkFolder, FOLDERID_Pictures,
        IFileDialog, FDAP_BOTTOM, FDAP_TOP, SIGDN_FILESYSPATH,
    };

    let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    if hr.is_err() {
        return Err("无法初始化目录对话框。".into());
    }
    let owned_com = hr.0 == 0;
    struct ComGuard(bool);
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }
    let _com = ComGuard(owned_com);

    let dialog: IFileDialog = CoCreateInstance(clsid, None, CLSCTX_INPROC_SERVER)
        .map_err(|_| "无法创建目录对话框。".to_string())?;
    dialog
        .SetOptions(options)
        .map_err(|_| "无法配置目录对话框。".to_string())?;
    dialog
        .SetTitle(title)
        .map_err(|_| "无法配置目录对话框。".to_string())?;
    if let Some(label) = ok_label {
        dialog
            .SetOkButtonLabel(label)
            .map_err(|_| "无法配置目录对话框。".to_string())?;
    }
    if let Some(name) = file_name {
        dialog
            .SetFileName(name)
            .map_err(|_| "无法配置目录对话框。".to_string())?;
    }
    // A drive root such as C:\ has no filesystem parent. Give the common item
    // dialog an explicit Shell namespace root so users can always switch to a
    // different drive instead of getting stranded at the current drive root.
    // Network is also explicit because mapped drives are not the only valid
    // location for a gallery.
    if let Some(computer) = known_folder_item(&FOLDERID_ComputerFolder) {
        let _ = dialog.AddPlace(&computer, FDAP_TOP);
        let _ = dialog.SetDefaultFolder(&computer);
        let _ = dialog.SetFolder(&computer);
    }
    if let Some(network) = known_folder_item(&FOLDERID_NetworkFolder) {
        let _ = dialog.AddPlace(&network, FDAP_TOP);
    }
    for id in [FOLDERID_Pictures, FOLDERID_Desktop] {
        if let Some(folder) = known_folder_item(&id) {
            let _ = dialog.AddPlace(&folder, FDAP_BOTTOM);
        }
    }

    match dialog.Show(Some(owner)) {
        Ok(()) => {}
        Err(error) if error.code().0 == HRESULT_CANCELLED => return Ok(None),
        Err(_) => return Err("无法打开目录对话框。".into()),
    }

    let item = dialog
        .GetResult()
        .map_err(|_| "无法读取所选路径。".to_string())?;
    let name = item
        .GetDisplayName(SIGDN_FILESYSPATH)
        .map_err(|_| "无法读取所选路径。".to_string())?;
    let text = name
        .to_string()
        .map_err(|_| "无法读取所选路径。".to_string())?;
    CoTaskMemFree(Some(name.as_ptr() as *const _));
    if text.is_empty() {
        return Err("所选路径为空。".into());
    }
    let path = PathBuf::from(text);
    if !path.is_absolute() {
        return Err("图库目录必须是绝对路径。".into());
    }
    Ok(Some(path))
}

#[cfg(windows)]
unsafe fn known_folder_item(
    id: &windows::core::GUID,
) -> Option<windows::Win32::UI::Shell::IShellItem> {
    use windows::Win32::UI::Shell::{IShellItem, SHGetKnownFolderItem, KF_FLAG_DEFAULT};

    SHGetKnownFolderItem::<IShellItem>(id, KF_FLAG_DEFAULT, None).ok()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{FOLDERID_ComputerFolder, FOLDERID_NetworkFolder};

    #[test]
    fn shell_roots_are_available_for_cross_drive_navigation() {
        unsafe {
            let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            assert!(hr.is_ok(), "COM initialization failed: {hr:?}");
            let owned_com = hr.0 == 0;

            assert!(known_folder_item(&FOLDERID_ComputerFolder).is_some());
            assert!(known_folder_item(&FOLDERID_NetworkFolder).is_some());

            if owned_com {
                CoUninitialize();
            }
        }
    }
}
