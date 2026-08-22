/**
 * Home Assistant response formatting helpers.
 *
 * Mirrors Python `homeassistant_tool.py` helpers:
 * - `_filter_and_summarize()`
 * - `_build_service_payload()`
 * - `_parse_service_response()`
 */

import { isValidEntityId } from "./security.js";

export interface HassState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

export interface HassStateSummary {
  entity_id: string;
  state: string;
  friendly_name: string;
}

export interface HassEntitiesSummary {
  count: number;
  entities: HassStateSummary[];
}

export interface HassServiceField {
  description?: string;
  name?: string;
  example?: unknown;
  selector?: unknown;
  required?: boolean;
  advanced?: boolean;
}

export interface HassServiceDescription {
  description: string;
  fields?: Record<string, HassServiceField>;
}

export interface HassDomainServices {
  domain: string;
  services: Record<string, HassServiceDescription>;
}

export interface HassServicesSummary {
  count: number;
  domains: HassDomainServices[];
}

export interface HassAffectedEntity {
  entity_id: string;
  state: string;
}

export interface HassServiceResult {
  success: true;
  service: string;
  affected_entities: HassAffectedEntity[];
}

function getFriendlyName(state: HassState): string {
  const attr = state.attributes ?? {};
  if (typeof attr.friendly_name === "string" && attr.friendly_name.length > 0) {
    return attr.friendly_name;
  }
  return state.entity_id;
}

function getArea(state: HassState): string {
  const attr = state.attributes ?? {};
  if (typeof attr.area === "string") return attr.area;
  if (typeof attr.area_id === "string") return attr.area_id;
  return "";
}

/**
 * Summarize a list of HA states with optional domain and area filters.
 * Area matches `friendly_name` or `attributes.area` case-insensitively,
 * matching the Python implementation.
 */
export function filterAndSummarize(
  states: HassState[],
  filter?: { domain?: string; area?: string },
): HassEntitiesSummary {
  const domain = filter?.domain?.toLowerCase().trim();
  const area = filter?.area?.toLowerCase().trim();

  const filtered = states.filter((state) => {
    if (domain && !state.entity_id.toLowerCase().startsWith(`${domain}.`)) {
      return false;
    }
    if (area) {
      const friendly = getFriendlyName(state).toLowerCase();
      const stateArea = getArea(state).toLowerCase();
      if (!friendly.includes(area) && !stateArea.includes(area)) {
        return false;
      }
    }
    return true;
  });

  return {
    count: filtered.length,
    entities: filtered.map((state) => ({
      entity_id: state.entity_id,
      state: state.state,
      friendly_name: getFriendlyName(state),
    })),
  };
}

/**
 * Build the service-call payload. The explicit `entity_id` parameter wins over
 * `data.entity_id`, matching Python's `_build_service_payload()`.
 */
export function buildServicePayload(
  domain: string,
  service: string,
  entityId?: string,
  data?: Record<string, unknown>,
): { domain: string; service: string; payload: Record<string, unknown> } {
  const payload: Record<string, unknown> = { ...(data ?? {}) };
  if (entityId && isValidEntityId(entityId)) {
    payload.entity_id = entityId;
  }
  return { domain, service, payload };
}

/**
 * Parse a service-call response. HA returns an array of updated state objects.
 * Empty responses are treated as a successful call with no affected entities.
 */
export function parseServiceResponse(
  domain: string,
  service: string,
  responseBody: unknown,
): HassServiceResult {
  const affected: HassAffectedEntity[] = [];
  if (Array.isArray(responseBody)) {
    for (const item of responseBody) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as HassState).entity_id === "string" &&
        typeof (item as HassState).state === "string"
      ) {
        affected.push({
          entity_id: (item as HassState).entity_id,
          state: (item as HassState).state,
        });
      }
    }
  }
  return {
    success: true,
    service: `${domain}.${service}`,
    affected_entities: affected,
  };
}

/**
 * Compact a full `/api/services` response to per-domain descriptions and
 * field names. Matches Python's `_async_list_services()` compact output.
 */
export function summarizeServices(
  services: Record<string, Record<string, HassServiceDescription>>,
  domainFilter?: string,
): HassServicesSummary {
  const domains: HassDomainServices[] = [];
  let count = 0;

  for (const [domain, serviceMap] of Object.entries(services)) {
    if (domainFilter && domain.toLowerCase() !== domainFilter.toLowerCase()) {
      continue;
    }
    const servicesRecord: Record<string, HassServiceDescription> = {};
    for (const [serviceName, service] of Object.entries(serviceMap)) {
      const fields: Record<string, HassServiceField> = {};
      if (service.fields) {
        for (const [fieldName, field] of Object.entries(service.fields)) {
          fields[fieldName] = {
            description: typeof field?.description === "string" ? field.description : undefined,
          };
        }
      }
      servicesRecord[serviceName] = { description: service.description ?? "", fields };
      count++;
    }
    domains.push({ domain, services: servicesRecord });
  }

  return { count, domains };
}
