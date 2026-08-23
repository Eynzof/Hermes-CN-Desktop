import { atom } from "jotai";
import type { UserInfo } from "@/lib/wanderminds-id";

export const wandermindsAuthAtom = atom<UserInfo | null>(null);
