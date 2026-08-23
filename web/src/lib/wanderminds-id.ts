import type { WandermindsAuthResult, WandermindsUserInfo } from "@hermes/protocol";

export type UserInfo = WandermindsUserInfo;

function desktopBridge() {
  return typeof window === "undefined" ? undefined : window.hermesDesktop;
}

function userFromResult(result: WandermindsAuthResult | undefined): UserInfo | null {
  return result?.user ?? null;
}

export async function wandermindsIdLogin(): Promise<UserInfo | null> {
  const login = desktopBridge()?.wandermindsIdLogin;
  if (!login) throw new Error("Wanderminds ID 仅支持社区桌面端");
  return userFromResult(await login());
}

export async function wandermindsIdRefresh(): Promise<UserInfo | null> {
  const refresh = desktopBridge()?.wandermindsIdRefresh;
  if (!refresh) throw new Error("Wanderminds ID 仅支持社区桌面端");
  return userFromResult(await refresh());
}

export async function wandermindsIdStatus(): Promise<UserInfo | null> {
  const status = desktopBridge()?.wandermindsIdStatus;
  return status ? await status() : null;
}

export async function wandermindsIdLogout(): Promise<void> {
  await desktopBridge()?.wandermindsIdLogout?.();
}
