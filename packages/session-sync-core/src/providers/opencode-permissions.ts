export function createOpenCodeMessagePermissionOptions(
  permissionMode: string | null | undefined
): Record<string, never> {
  // OpenCode 消息接口不接受权限字段；权限由托管 server 配置决定。
  void permissionMode;
  return {};
}
