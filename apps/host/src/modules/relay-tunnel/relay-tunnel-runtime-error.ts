/**
 * 公共隧道运行时的 HTTP 错误（spec001.9）
 *
 * 为什么单独一个文件：
 *
 * 这个类型原来住在老的 WSS 适配器里（那个适配器已随 W6.1 删除）。
 * 它其实是**运行时适配器和 `RelayTunnelService` 之间的契约**，不是老适配器的私货：
 * 服务靠 `instanceof RelayTunnelRuntimeHttpError` + `errorCode` 判断
 * 「这条绑定在控制站上已经不存在了」，进而把本地绑定状态清回 `unbound`，
 * 让用户能重新绑定。
 *
 * 只要这个判断还在，WebRTC 适配器就必须抛同一族错误；把类型留在待下线的老文件里，
 * 会出现「老适配器删了、服务还在 import 它」的尴尬，也会让人误以为新适配器不用管这个契约。
 *
 * `statusCode` 用 0 表示「不是 HTTP 失败」，例如本机 DTLS 证书还没生成这种本地配置问题。
 */
export class RelayTunnelRuntimeHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly errorCode: string | null,
    readonly detail: string,
    prefix: string
  ) {
    super(`${prefix}：${detail}`);
    this.name = "RelayTunnelRuntimeHttpError";
  }
}
