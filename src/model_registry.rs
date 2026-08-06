//! 受管 provider 注册表 —— 三类模型（内置 / 企业 / 自定义）唯一的 config.yaml 写入方。
//!
//! # 为什么需要这一层
//!
//! Core 对同一个 provider 有三套互不一致的标识推导：
//!
//! - `model.options` 对 `providers:` map 条目回发**配置键**原样
//!   （`hermes_cli/model_switch.py` 的 Section 3），对 `custom_providers:`
//!   列表条目回发**显示名派生**的 slug（`custom_provider_slug`）。
//! - `resolve_user_provider` 按**精确配置键**查表，且查之前把入参 lower 过，
//!   但 Core 回发配置键时并不 lower。
//! - 桌面端历史上还会在 slug 含 `.` 时剥掉 `custom:` 前缀。
//!
//! 三者只要有一处对不上，模型切换就会静默改道到别的 provider——用户选
//! deepseek、实际打到 claude 就是这么来的。
//!
//! 本模块把写入收敛成一条路径，让配置键同时落在三条解析路径的交集里：
//!
//! 1. 一律写 `providers:` map，**永不写 `custom_providers:`**，这样 Core 回发
//!    的就是配置键本身。
//! 2. 键格式固定为 `custom:<ns>-<slug>`，全小写、无 `.`——既不与 Core 内建
//!    slug 相撞，也不会触发任何剥前缀逻辑。
//! 3. `model:` 恒为映射，`model.default` 只放模型名、`model.provider` 只放
//!    provider id。写成标量会让 Core 的 `_get_model_config()` 退化成
//!    `{"default": <str>}` 并丢掉 provider/base_url/api_key。

use serde_yaml::{Mapping, Value};

/// 受管命名空间。每类模型独占一个前缀，分类因此是纯前缀判断。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedNamespace {
    /// 内置模型：品牌 serviceUrl 账号下发。
    Account,
    /// 企业模型：设备令牌同步下发。
    Team,
    /// 自定义模型：用户自填 baseUrl。
    User,
}

impl ManagedNamespace {
    pub fn prefix(self) -> &'static str {
        match self {
            ManagedNamespace::Account => "custom:acct-",
            ManagedNamespace::Team => "custom:team-",
            ManagedNamespace::User => "custom:user-",
        }
    }

    pub fn all() -> [ManagedNamespace; 3] {
        [
            ManagedNamespace::Account,
            ManagedNamespace::Team,
            ManagedNamespace::User,
        ]
    }

    /// 判断一个 provider id 属于哪个受管命名空间；用户手写的 provider 返回 None。
    pub fn classify(provider_id: &str) -> Option<ManagedNamespace> {
        let lowered = provider_id.trim().to_ascii_lowercase();
        Self::all()
            .into_iter()
            .find(|ns| lowered.starts_with(ns.prefix()))
    }
}

/// Core 能无损 round-trip 的写线协议模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiMode {
    ChatCompletions,
    AnthropicMessages,
}

impl ApiMode {
    fn api_mode(self) -> &'static str {
        match self {
            ApiMode::ChatCompletions => "chat_completions",
            ApiMode::AnthropicMessages => "anthropic_messages",
        }
    }

    /// Core 的 provider 条目同时带 `api_mode` 与 `transport`，两者必须一致，
    /// 否则 `determine_api_mode` 会按 base_url 重新猜。
    fn transport(self) -> &'static str {
        match self {
            ApiMode::ChatCompletions => "openai_chat",
            ApiMode::AnthropicMessages => "anthropic_messages",
        }
    }
}

/// 单个模型的能力声明，落进 provider 的 `models:` 字典。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ManagedModel {
    pub id: String,
    pub context_length: Option<u64>,
    pub supports_tools: Option<bool>,
    pub supports_vision: Option<bool>,
    pub supports_reasoning: Option<bool>,
}

impl ManagedModel {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            ..Default::default()
        }
    }
}

/// 一个受管 provider 的完整期望状态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedProvider {
    /// 规范 provider id，同时是 `providers:` 的配置键与网关 slug。
    pub id: String,
    pub namespace: ManagedNamespace,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub api_mode: ApiMode,
    /// 该 provider 的当前模型，必须出现在 `models` 中。
    pub model: String,
    pub models: Vec<ManagedModel>,
    /// 附加的 provider 级字段（例如账号 provider 记录背后的中转站 token_id）。
    /// 在受管字段之后写入，但不允许覆盖它们。
    pub extra: Vec<(String, Value)>,
}

/// 把任意字符串收敛成 provider id 可用的 slug 片段。
///
/// 转小写 → 非 `[a-z0-9_-]`（含 `.`）替换为 `-` → 合并连续 `-` → 去首尾 `-`。
/// 去点这一步是必须的：`glm-5.2`、`kimi-k2.6` 这类 id 一旦带点，桌面端历史
/// 上的剥前缀逻辑就会把 `custom:` 丢掉，Core 精确键查表随即落空。
pub fn sanitize_slug(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut pending_dash = false;
    for ch in input.trim().chars() {
        let mapped = if ch.is_ascii_alphanumeric() {
            Some(ch.to_ascii_lowercase())
        } else if ch == '_' {
            Some('_')
        } else {
            None
        };
        match mapped {
            Some(c) => {
                if pending_dash && !out.is_empty() {
                    out.push('-');
                }
                pending_dash = false;
                out.push(c);
            }
            None => {
                // 非 ASCII（例如中文显示名）与所有标点一律折叠成单个分隔符。
                pending_dash = true;
            }
        }
    }
    out
}

/// 构造规范 provider id。slug 为空时回退到 `unnamed`，保证 id 永远可解析。
pub fn managed_provider_id(namespace: ManagedNamespace, raw: &str) -> String {
    let slug = sanitize_slug(raw);
    let slug = if slug.is_empty() { "unnamed" } else { &slug };
    format!("{}{}", namespace.prefix(), slug)
}

fn as_mapping_mut(value: &mut Value) -> Option<&mut Mapping> {
    if value.is_null() {
        *value = Value::Mapping(Mapping::new());
    }
    value.as_mapping_mut()
}

fn provider_entry(provider: &ManagedProvider) -> Value {
    let mut entry = Mapping::new();
    entry.insert("name".into(), provider.name.clone().into());
    // Core 的 providers_dict_to_custom_providers 会把配置键当作 provider_key
    // 带下去；显式写一份让两种读法都拿到同一个稳定标识。
    entry.insert("provider_key".into(), provider.id.clone().into());
    entry.insert("base_url".into(), provider.base_url.clone().into());
    entry.insert("api_key".into(), provider.api_key.clone().into());
    entry.insert("api_mode".into(), provider.api_mode.api_mode().into());
    entry.insert("transport".into(), provider.api_mode.transport().into());
    entry.insert("model".into(), provider.model.clone().into());
    // 下发清单即权威。放任 Core 去探 /v1/models 会用中转站的全量目录覆盖掉
    // 明确同步下来的模型集合。
    entry.insert("discover_models".into(), false.into());

    let mut models = Mapping::new();
    for model in &provider.models {
        let mut meta = Mapping::new();
        if let Some(n) = model.context_length {
            meta.insert("context_length".into(), n.into());
        }
        if let Some(v) = model.supports_tools {
            meta.insert("supports_tools".into(), v.into());
        }
        if let Some(v) = model.supports_vision {
            meta.insert("supports_vision".into(), v.into());
        }
        if let Some(v) = model.supports_reasoning {
            meta.insert("supports_reasoning".into(), v.into());
        }
        models.insert(model.id.clone().into(), Value::Mapping(meta));
    }
    entry.insert("models".into(), Value::Mapping(models));

    // 附加字段不得覆盖受管字段——否则调用方可以绕过标识规范化。
    for (key, value) in &provider.extra {
        if entry.contains_key(Value::from(key.as_str())) {
            continue;
        }
        entry.insert(key.clone().into(), value.clone());
    }
    Value::Mapping(entry)
}

/// 把某些命名空间下的受管 provider 同步成 `desired` 描述的状态。
///
/// 只接管 `scope` 覆盖的命名空间：企业同步不会误删账号 provider，反之亦然。
/// 任何不属于受管命名空间的 provider（用户手写的、Core 内建的）一律不碰。
pub fn apply_managed_providers(
    config: &mut Value,
    scope: &[ManagedNamespace],
    desired: &[ManagedProvider],
) -> Result<(), String> {
    let root =
        as_mapping_mut(config).ok_or_else(|| "config.yaml root must be an object".to_string())?;

    let mut providers = root
        .remove(Value::String("providers".into()))
        .unwrap_or_else(|| Value::Mapping(Mapping::new()));
    if providers.is_null() {
        providers = Value::Mapping(Mapping::new());
    }
    let providers_map = providers
        .as_mapping_mut()
        .ok_or_else(|| "providers must be a mapping".to_string())?;

    // 先摘掉 scope 内的旧条目，再整体重建——这样被移除的模型不会留残骸。
    let stale: Vec<Value> = providers_map
        .iter()
        .filter_map(|(key, _)| {
            let id = key.as_str()?;
            ManagedNamespace::classify(id)
                .filter(|ns| scope.contains(ns))
                .map(|_| key.clone())
        })
        .collect();
    for key in stale {
        providers_map.remove(&key);
    }

    for provider in desired {
        providers_map.insert(provider.id.clone().into(), provider_entry(provider));
    }

    root.insert(Value::String("providers".into()), providers);
    Ok(())
}

/// 写入全局默认模型。
///
/// `model:` 恒为映射：Core 的 `_get_model_config()` 遇到标量会退化成
/// `{"default": <str>}` 并丢掉 provider / base_url / api_key，让后续所有会话
/// 回落到猜测链路。
pub fn set_default_model(
    config: &mut Value,
    provider: &ManagedProvider,
    model: &str,
) -> Result<(), String> {
    let root =
        as_mapping_mut(config).ok_or_else(|| "config.yaml root must be an object".to_string())?;

    let mut model_cfg = match root.remove(Value::String("model".into())) {
        Some(Value::Mapping(existing)) => existing,
        // 标量或缺失都重建成映射；标量形态本身就是要修的 bug。
        _ => Mapping::new(),
    };
    model_cfg.insert("provider".into(), provider.id.clone().into());
    model_cfg.insert("default".into(), model.into());
    model_cfg.insert("base_url".into(), provider.base_url.clone().into());
    model_cfg.insert("api_mode".into(), provider.api_mode.api_mode().into());
    model_cfg.insert("api_key".into(), provider.api_key.clone().into());
    root.insert(Value::String("model".into()), Value::Mapping(model_cfg));
    Ok(())
}

/// 若当前默认模型指向 `scope` 内某个已消失的受管 provider，则清掉它。
pub fn clear_default_model_if_managed(config: &mut Value, scope: &[ManagedNamespace]) {
    let Some(root) = config.as_mapping_mut() else {
        return;
    };
    let points_at_managed = match root.get("model") {
        // 标量形态是历史 bug 的产物：值往往是个 provider id 而非模型名。
        Some(Value::String(raw)) => {
            ManagedNamespace::classify(raw).is_some_and(|ns| scope.contains(&ns))
        }
        Some(Value::Mapping(map)) => map
            .get("provider")
            .and_then(Value::as_str)
            .and_then(ManagedNamespace::classify)
            .is_some_and(|ns| scope.contains(&ns)),
        _ => false,
    };
    if points_at_managed {
        root.remove("model");
    }
}

/// 把历史配置形态迁移到规范形态。返回 true 表示 config 被改动过。
///
/// 处理三种遗留产物：
///
/// 1. `custom_providers:` 列表里由旧版 `team_sync` 写下的 `team_managed: true`
///    条目（旧写入方按此标记清理，新写入方按键前缀清理，两者不相交，会互留残骸）。
/// 2. 旧版账号 provisioning 写下的 `custom:<brand>` / `custom:<brand>-messages`
///    条目——它们带着上一个用户的 api_key，且没有任何代码会刷新。
/// 3. 标量 `model:`（值往往是 provider id 而非模型名）。
///
/// `brand_provider_key` 传品牌的 providerKey，用于识别第 2 类。
pub fn migrate_legacy_config(config: &mut Value, brand_provider_key: &str) -> bool {
    let Some(root) = as_mapping_mut(config) else {
        return false;
    };
    let mut changed = false;

    // 1. 摘掉旧 team_managed 列表条目。新写入方会用 providers: map 重建它们，
    //    所以这里只删不转——保留会变成重复 provider。
    if let Some(seq) = root
        .get_mut("custom_providers")
        .and_then(Value::as_sequence_mut)
    {
        let before = seq.len();
        seq.retain(|entry| {
            let team_managed = entry.get("team_managed").and_then(Value::as_bool) == Some(true);
            let legacy_key = entry
                .get("provider_key")
                .and_then(Value::as_str)
                .is_some_and(|key| key.starts_with("team-"));
            !(team_managed || legacy_key)
        });
        if seq.len() != before {
            changed = true;
        }
        if seq.is_empty() {
            root.remove("custom_providers");
        }
    }

    // 2. 删掉旧账号 provider。它们的 api_key 归属上一个登录用户，且本分支上
    //    没有任何代码会刷新它——留着就是「换账号后 key 不刷新」的成因。
    let brand_slug = sanitize_slug(brand_provider_key);
    if !brand_slug.is_empty() {
        if let Some(providers) = root.get_mut("providers").and_then(Value::as_mapping_mut) {
            let legacy: Vec<Value> = providers
                .iter()
                .filter_map(|(key, _)| {
                    let id = key.as_str()?.trim().to_ascii_lowercase();
                    let bare = id.strip_prefix("custom:")?;
                    (bare == brand_slug || bare == format!("{brand_slug}-messages"))
                        .then(|| key.clone())
                })
                .collect();
            for key in legacy {
                providers.remove(&key);
                changed = true;
            }
        }
    }

    // 3. 标量 model: 一律丢弃。值通常是个 provider id，Core 会把它当模型名，
    //    于是每个回落到全局默认的会话都进猜测链路。
    if matches!(root.get("model"), Some(Value::String(_))) {
        root.remove("model");
        changed = true;
    }

    changed
}

/// 在 JSON 形态的 config 上执行受管 provider 同步。
///
/// 账号 provisioning 走 dashboard 的 `/api/config`（JSON），而设备令牌同步直接
/// 读写 `config.yaml`（YAML）。两条路径必须产出**完全一致**的配置形态，否则
/// provider 标识又会分叉——所以这里把 JSON 转成 YAML 树复用同一套实现，而不是
/// 另写一份 JSON 版逻辑。
pub fn apply_managed_providers_json(
    config: &mut serde_json::Value,
    scope: &[ManagedNamespace],
    desired: &[ManagedProvider],
) -> Result<(), String> {
    with_json_as_yaml(config, |yaml| apply_managed_providers(yaml, scope, desired))
}

/// JSON 形态的 [`set_default_model`]。
pub fn set_default_model_json(
    config: &mut serde_json::Value,
    provider: &ManagedProvider,
    model: &str,
) -> Result<(), String> {
    with_json_as_yaml(config, |yaml| set_default_model(yaml, provider, model))
}

/// JSON 形态的 [`migrate_legacy_config`]。
pub fn migrate_legacy_config_json(
    config: &mut serde_json::Value,
    brand_provider_key: &str,
) -> Result<bool, String> {
    let mut changed = false;
    with_json_as_yaml(config, |yaml| {
        changed = migrate_legacy_config(yaml, brand_provider_key);
        Ok(())
    })?;
    Ok(changed)
}

fn with_json_as_yaml(
    config: &mut serde_json::Value,
    mutate: impl FnOnce(&mut Value) -> Result<(), String>,
) -> Result<(), String> {
    let mut yaml: Value =
        serde_yaml::to_value(&*config).map_err(|e| format!("config JSON→YAML: {e}"))?;
    mutate(&mut yaml)?;
    *config = serde_json::to_value(&yaml).map_err(|e| format!("config YAML→JSON: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    fn provider(id: &str, namespace: ManagedNamespace) -> ManagedProvider {
        ManagedProvider {
            id: id.into(),
            namespace,
            name: "Display".into(),
            base_url: "https://relay.example/v1".into(),
            api_key: "wbd_token".into(),
            api_mode: ApiMode::ChatCompletions,
            model: "m1".into(),
            models: vec![ManagedModel::new("m1")],
            extra: Vec::new(),
        }
    }

    #[test]
    fn extra_fields_are_written_but_cannot_override_managed_ones() {
        let mut config = Value::Mapping(Mapping::new());
        let mut p = provider("custom:acct-brand", ManagedNamespace::Account);
        p.extra = vec![
            ("token_id".into(), 42.into()),
            // 试图覆盖受管字段必须被忽略。
            ("api_key".into(), "sk-attacker".into()),
        ];

        apply_managed_providers(&mut config, &[ManagedNamespace::Account], &[p]).unwrap();

        let entry = &config["providers"]["custom:acct-brand"];
        assert_eq!(entry["token_id"].as_i64(), Some(42));
        assert_eq!(entry["api_key"].as_str(), Some("wbd_token"));
    }

    #[test]
    fn sanitize_slug_strips_dots_that_break_the_desktop_round_trip() {
        // 含点的 id 会让桌面端剥掉 custom: 前缀，Core 精确键查表随即落空。
        assert_eq!(sanitize_slug("glm-5.2"), "glm-5-2");
        assert_eq!(sanitize_slug("kimi-k2.6"), "kimi-k2-6");
    }

    #[test]
    fn sanitize_slug_lowercases_and_collapses_separators() {
        // Core 查表前会把入参 lower，但回发配置键时不会——键必须自带小写。
        assert_eq!(sanitize_slug("Team-DeepSeek"), "team-deepseek");
        assert_eq!(sanitize_slug("  spaced   name  "), "spaced-name");
        assert_eq!(sanitize_slug("mdl_opaque_id"), "mdl_opaque_id");
    }

    #[test]
    fn sanitize_slug_folds_non_ascii_display_names() {
        assert_eq!(sanitize_slug("深度求索 v4"), "v4");
        assert_eq!(sanitize_slug("深度求索"), "");
    }

    #[test]
    fn managed_provider_id_falls_back_when_slug_is_empty() {
        assert_eq!(
            managed_provider_id(ManagedNamespace::Team, "深度求索"),
            "custom:team-unnamed"
        );
    }

    #[test]
    fn managed_provider_ids_never_contain_dots_or_uppercase() {
        let id = managed_provider_id(ManagedNamespace::Account, "FengchiHermes.CN");
        assert_eq!(id, "custom:acct-fengchihermes-cn");
        assert!(!id.contains('.'));
        assert_eq!(id, id.to_ascii_lowercase());
    }

    #[test]
    fn classify_only_matches_managed_prefixes() {
        assert_eq!(
            ManagedNamespace::classify("custom:team-a"),
            Some(ManagedNamespace::Team)
        );
        assert_eq!(
            ManagedNamespace::classify("custom:acct-a"),
            Some(ManagedNamespace::Account)
        );
        // 用户手写的 provider 与 Core 内建 provider 必须判定为非受管。
        assert_eq!(ManagedNamespace::classify("custom:my-own"), None);
        assert_eq!(ManagedNamespace::classify("anthropic"), None);
    }

    #[test]
    fn apply_replaces_only_providers_in_scope() {
        let mut config: Value = serde_yaml::from_str(
            r#"
providers:
  custom:team-old:
    name: Old team model
  custom:acct-brand:
    name: Account model
  custom:my-own:
    name: Hand written
  anthropic:
    name: Built in
"#,
        )
        .unwrap();

        apply_managed_providers(
            &mut config,
            &[ManagedNamespace::Team],
            &[provider("custom:team-new", ManagedNamespace::Team)],
        )
        .unwrap();

        let providers = config["providers"].as_mapping().unwrap();
        // scope 内的旧条目被换掉。
        assert!(!providers.contains_key(Value::from("custom:team-old")));
        assert!(providers.contains_key(Value::from("custom:team-new")));
        // scope 外的一律不动。
        assert!(providers.contains_key(Value::from("custom:acct-brand")));
        assert!(providers.contains_key(Value::from("custom:my-own")));
        assert!(providers.contains_key(Value::from("anthropic")));
    }

    #[test]
    fn apply_writes_matching_api_mode_and_transport() {
        let mut config = Value::Mapping(Mapping::new());
        let mut p = provider("custom:team-claude", ManagedNamespace::Team);
        p.api_mode = ApiMode::AnthropicMessages;

        apply_managed_providers(&mut config, &[ManagedNamespace::Team], &[p]).unwrap();

        let entry = &config["providers"]["custom:team-claude"];
        assert_eq!(entry["api_mode"].as_str(), Some("anthropic_messages"));
        assert_eq!(entry["transport"].as_str(), Some("anthropic_messages"));
        // 下发清单即权威，不能让 Core 用中转站目录覆盖。
        assert_eq!(entry["discover_models"].as_bool(), Some(false));
    }

    #[test]
    fn apply_is_idempotent() {
        let mut config = Value::Mapping(Mapping::new());
        let desired = [provider("custom:team-a", ManagedNamespace::Team)];

        apply_managed_providers(&mut config, &[ManagedNamespace::Team], &desired).unwrap();
        let first = config.clone();
        apply_managed_providers(&mut config, &[ManagedNamespace::Team], &desired).unwrap();

        assert_eq!(first, config);
    }

    #[test]
    fn apply_creates_the_providers_map_when_absent() {
        let mut config: Value = serde_yaml::from_str("model:\n  default: x\n").unwrap();
        apply_managed_providers(
            &mut config,
            &[ManagedNamespace::User],
            &[provider("custom:user-a", ManagedNamespace::User)],
        )
        .unwrap();
        assert!(config["providers"]["custom:user-a"].is_mapping());
    }

    #[test]
    fn set_default_model_always_writes_a_mapping() {
        // 回归 R2：标量 model: 会让 Core 丢掉 provider/base_url/api_key。
        let mut config: Value = serde_yaml::from_str("model: custom:team-glm-5-2\n").unwrap();
        let p = provider("custom:team-glm", ManagedNamespace::Team);

        set_default_model(&mut config, &p, "glm-5.2").unwrap();

        let model = config["model"]
            .as_mapping()
            .expect("model must be a mapping");
        assert_eq!(model["default"].as_str(), Some("glm-5.2"));
        assert_eq!(model["provider"].as_str(), Some("custom:team-glm"));
        assert_eq!(model["base_url"].as_str(), Some("https://relay.example/v1"));
        assert_eq!(model["api_key"].as_str(), Some("wbd_token"));
    }

    #[test]
    fn set_default_model_preserves_unrelated_model_keys() {
        let mut config: Value =
            serde_yaml::from_str("model:\n  context_length: 4096\n  default: old\n").unwrap();
        let p = provider("custom:team-a", ManagedNamespace::Team);

        set_default_model(&mut config, &p, "new").unwrap();

        assert_eq!(config["model"]["context_length"].as_u64(), Some(4096));
        assert_eq!(config["model"]["default"].as_str(), Some("new"));
    }

    #[test]
    fn clear_default_model_removes_scalar_provider_id_left_by_the_old_writer() {
        let mut config: Value = serde_yaml::from_str("model: custom:team-glm-5-2\n").unwrap();
        clear_default_model_if_managed(&mut config, &[ManagedNamespace::Team]);
        assert!(config.as_mapping().unwrap().get("model").is_none());
    }

    #[test]
    fn clear_default_model_keeps_models_owned_by_other_namespaces() {
        let mut config: Value =
            serde_yaml::from_str("model:\n  provider: custom:acct-brand\n  default: m\n").unwrap();
        clear_default_model_if_managed(&mut config, &[ManagedNamespace::Team]);
        assert_eq!(
            config["model"]["provider"].as_str(),
            Some("custom:acct-brand")
        );
    }

    #[test]
    fn clear_default_model_keeps_user_written_providers() {
        let mut config: Value =
            serde_yaml::from_str("model:\n  provider: anthropic\n  default: m\n").unwrap();
        clear_default_model_if_managed(&mut config, &ManagedNamespace::all());
        assert_eq!(config["model"]["provider"].as_str(), Some("anthropic"));
    }

    #[test]
    fn migrate_drops_legacy_team_managed_list_entries() {
        let mut config: Value = serde_yaml::from_str(
            r#"
custom_providers:
  - name: Old team
    provider_key: team-mdl_a
    team_managed: true
  - name: Hand written
    provider_key: my-own
    base_url: https://example/v1
"#,
        )
        .unwrap();

        assert!(migrate_legacy_config(&mut config, "fengchihermes"));

        let seq = config["custom_providers"].as_sequence().unwrap();
        assert_eq!(seq.len(), 1);
        assert_eq!(seq[0]["provider_key"].as_str(), Some("my-own"));
    }

    #[test]
    fn migrate_drops_the_stale_account_provider_and_its_key() {
        // 回归 R1：旧账号 provider 的 api_key 属于上一个登录用户，本分支上
        // 没有任何代码会刷新它。
        let mut config: Value = serde_yaml::from_str(
            r#"
providers:
  custom:fengchihermes:
    api_key: sk-stale-previous-user
  custom:fengchihermes-messages:
    api_key: sk-stale-previous-user
  custom:my-own:
    api_key: sk-mine
"#,
        )
        .unwrap();

        assert!(migrate_legacy_config(&mut config, "fengchihermes"));

        let providers = config["providers"].as_mapping().unwrap();
        assert!(!providers.contains_key(Value::from("custom:fengchihermes")));
        assert!(!providers.contains_key(Value::from("custom:fengchihermes-messages")));
        // 用户自己的 provider 必须留下。
        assert!(providers.contains_key(Value::from("custom:my-own")));
    }

    #[test]
    fn migrate_drops_scalar_model_config() {
        let mut config: Value = serde_yaml::from_str("model: custom:team-glm-5-2\n").unwrap();
        assert!(migrate_legacy_config(&mut config, "fengchihermes"));
        assert!(config.as_mapping().unwrap().get("model").is_none());
    }

    #[test]
    fn migrate_keeps_mapping_model_config() {
        let mut config: Value =
            serde_yaml::from_str("model:\n  provider: anthropic\n  default: m\n").unwrap();
        assert!(!migrate_legacy_config(&mut config, "fengchihermes"));
        assert_eq!(config["model"]["default"].as_str(), Some("m"));
    }

    #[test]
    fn json_and_yaml_paths_produce_identical_config_shapes() {
        // 账号 provisioning 走 JSON、设备令牌同步走 YAML；两者必须写出同一形态，
        // 否则 provider 标识会再次分叉。
        let p = provider("custom:acct-brand", ManagedNamespace::Account);

        let mut yaml_config = Value::Mapping(Mapping::new());
        apply_managed_providers(
            &mut yaml_config,
            &[ManagedNamespace::Account],
            std::slice::from_ref(&p),
        )
        .unwrap();
        set_default_model(&mut yaml_config, &p, "m1").unwrap();

        let mut json_config = serde_json::json!({});
        apply_managed_providers_json(
            &mut json_config,
            &[ManagedNamespace::Account],
            std::slice::from_ref(&p),
        )
        .unwrap();
        set_default_model_json(&mut json_config, &p, "m1").unwrap();

        let yaml_as_json: serde_json::Value = serde_json::to_value(&yaml_config).unwrap();
        assert_eq!(yaml_as_json, json_config);
    }

    #[test]
    fn json_migration_drops_the_stale_account_provider() {
        let mut config = serde_json::json!({
            "providers": {
                "custom:fengchihermes": { "api_key": "sk-stale" },
                "custom:my-own": { "api_key": "sk-mine" }
            }
        });

        assert!(migrate_legacy_config_json(&mut config, "fengchihermes").unwrap());

        assert!(config["providers"].get("custom:fengchihermes").is_none());
        assert!(config["providers"].get("custom:my-own").is_some());
    }

    #[test]
    fn migrate_is_idempotent_and_reports_no_change_on_clean_config() {
        let mut config: Value = serde_yaml::from_str(
            r#"
providers:
  custom:team-a:
    api_key: wbd
model:
  provider: custom:team-a
  default: m
"#,
        )
        .unwrap();

        assert!(!migrate_legacy_config(&mut config, "fengchihermes"));
        let snapshot = config.clone();
        assert!(!migrate_legacy_config(&mut config, "fengchihermes"));
        assert_eq!(snapshot, config);
    }
}
