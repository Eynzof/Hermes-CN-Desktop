import { atom } from "jotai";
import { readUiValue, removeUiValue, writeUiValue } from "@/lib/ui-store";
import type { HuanxingAccount } from "@/lib/huanxing-auth";

/**
 * 企业账号（Huanxing-api）登录态。accessToken / sessionCookie 随 ui_store
 * 持久化在本机，与 config.yaml 里的 provider api_key 同等敏感度。
 */
const HUANXING_AUTH_KEY = "hermes.huanxing-auth";

function readStoredAccount(): HuanxingAccount | null {
  const value = readUiValue<HuanxingAccount | null>(HUANXING_AUTH_KEY, null);
  if (!value || typeof value !== "object") return null;
  if (typeof value.userId !== "number" || !value.username) return null;
  if (!value.accessToken && !value.sessionCookie) return null;
  return value;
}

const huanxingAuthBaseAtom = atom<HuanxingAccount | null>(readStoredAccount());

export const huanxingAuthAtom = atom(
  (get) => get(huanxingAuthBaseAtom),
  (_get, set, next: HuanxingAccount | null) => {
    set(huanxingAuthBaseAtom, next);
    if (next) writeUiValue(HUANXING_AUTH_KEY, next);
    else removeUiValue(HUANXING_AUTH_KEY);
  },
);

/** 登录 / 注册弹窗开关。 */
export const authDialogOpenAtom = atom<boolean>(false);
