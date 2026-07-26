import { atom } from "jotai";

/** 企业设备令牌设置弹窗的开关。令牌本身由 Rust 写入 profile 私有文件。 */
export const authDialogOpenAtom = atom<boolean>(false);
