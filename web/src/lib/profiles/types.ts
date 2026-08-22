export interface ProfileHome {
  name: string;
  root: string;
  isDefault: boolean;
}

export interface ProfileSummary {
  name: string;
  path: string;
  isDefault: boolean;
  description?: string;
}

export interface ProfileCreateRequest {
  name: string;
  clone?: string;
  cloneAll?: boolean;
  noSkills?: boolean;
}
