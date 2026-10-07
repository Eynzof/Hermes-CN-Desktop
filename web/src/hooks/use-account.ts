import { useSetAtom } from "jotai";
import { accountModelNamesAtom } from "@/stores/auth";
import { BRAND } from "@/lib/brand.generated";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidateModelOptionsCache } from "@/lib/model-options-cache";
import type {
  AccountBalanceInfo,
  AccountLoginInput,
  AccountSavedCredentialsInfo,
  AccountSaveModelsInput,
  AccountSetupResult,
  AccountStatusResult,
  AccountTestModelResult,
  AccountTokenInfo,
  AccountUser,
} from "@/lib/runtime";

function bridge() {
  const value = window.hermesDesktop;
  if (!value?.accountStatus) throw new Error("账户登录仅在桌面版可用");
  return value;
}

export function isAccountLoginAvailable(): boolean {
  return Boolean(window.hermesDesktop?.accountStatus);
}

export function useAccountStatus() {
  const setModelNames = useSetAtom(accountModelNamesAtom);
  return useQuery<AccountStatusResult>({
    queryKey: ["account-status"],
    queryFn: async () => {
      const status = await bridge().accountStatus!();
      if (BRAND.accountBackend === "ccwork") {
        setModelNames(status.loggedIn ? (await bridge().accountFetchSetup!()).modelNames ?? {} : {});
      }
      return status;
    },
    enabled: isAccountLoginAvailable(),
    staleTime: 30_000,
  });
}

export function useAccountLogin() {
  const queryClient = useQueryClient();
  return useMutation<AccountUser, Error, AccountLoginInput>({
    mutationFn: (input) => bridge().accountLogin!(input),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["account-status"] }); },
  });
}

export function useAccountFetchSetup() {
  const setModelNames = useSetAtom(accountModelNamesAtom);
  return useMutation<AccountSetupResult, Error, void>({ mutationFn: async () => { const setup = await bridge().accountFetchSetup!(); setModelNames(setup.modelNames ?? {}); return setup; } });
}

export function useAccountTokens() {
  return useQuery<AccountTokenInfo[]>({
    queryKey: ["account-tokens"],
    queryFn: () => bridge().accountListTokens!(),
    enabled: false,
    retry: false,
  });
}

export function useAccountBalance(enabled = false) {
  return useQuery<AccountBalanceInfo>({
    queryKey: ["account-balance"],
    queryFn: () => bridge().accountBalance!(),
    enabled: enabled && isAccountLoginAvailable(),
    refetchInterval: enabled ? 30_000 : false,
    staleTime: 15_000,
  });
}

export function useAccountSaveModels() {
  const queryClient = useQueryClient();
  return useMutation<AccountStatusResult, Error, AccountSaveModelsInput>({
    mutationFn: (input) => bridge().accountSaveModels!(input),
    onSuccess: () => {
      invalidateModelOptionsCache();
      void queryClient.invalidateQueries({ queryKey: ["account-status"] });
      void queryClient.invalidateQueries({ queryKey: ["config"] });
      void queryClient.invalidateQueries({ queryKey: ["model-info"] });
      void queryClient.invalidateQueries({ queryKey: ["model-options"] });
    },
  });
}

export function useAccountTestModel() {
  return useMutation<AccountTestModelResult, Error, string>({ mutationFn: (id) => bridge().accountTestModel!(id) });
}

export function useAccountLogout() {
  const queryClient = useQueryClient();
  return useMutation<AccountStatusResult, Error, void>({
    mutationFn: () => bridge().accountLogout!(),
    onSuccess: () => {
      invalidateModelOptionsCache();
      for (const key of ["account-status", "account-balance", "model-options", "model-info", "config"]) void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
}

export function useSavedCredentials() {
  return useQuery<AccountSavedCredentialsInfo>({
    queryKey: ["account-saved-credentials"],
    queryFn: () => bridge().accountHasSavedCredentials!(),
    enabled: isAccountLoginAvailable(),
    staleTime: 30_000,
  });
}

export function useSaveCredentials() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, AccountLoginInput>({
    mutationFn: (input) => bridge().accountSaveCredentials!(input),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["account-saved-credentials"] }); },
  });
}

export function useLoginSaved() {
  const queryClient = useQueryClient();
  return useMutation<AccountUser, Error, void>({
    mutationFn: () => bridge().accountLoginSaved!(),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["account-status"] }); },
  });
}

export function useClearCredentials() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, void>({
    mutationFn: () => bridge().accountClearCredentials!(),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["account-saved-credentials"] }); },
  });
}
