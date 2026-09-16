use std::ffi::OsStr;
use std::process::Command;

/// 桌面端是 GUI 程序，在 Windows 上直接拉 node、powershell、taskkill 这类控制台程序时，
/// 系统会额外弹一个黑色控制台窗口。统一用这个函数创建命令，加上“不要建窗口”的标记。
/// 其它平台行为不变。
pub fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
}
