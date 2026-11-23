export function buildGatewayModelConfigValue(model: string, provider?: string): string {
  // model.options supplies the routing identifier, including the custom: prefix.
  return provider ? `${model} --provider ${provider}` : model;
}
