export function desktopArtifactObjectPaths({ channelRoot, fileName, version }) {
  return [`${channelRoot}/releases/v${version}/${fileName}`];
}

export function signedManifestRequiresObject(signedArtifactUrls, objectUrl) {
  return signedArtifactUrls.has(new URL(objectUrl).toString());
}
