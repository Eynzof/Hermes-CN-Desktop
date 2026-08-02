export function desktopArtifactObjectPaths({ channelRoot, fileName, version }) {
  return [`${channelRoot}/releases/v${version}/${fileName}`];
}

export function desktopUpdateManifest({ assets, channel, publishedAt, semver, version }) {
  return {
    version,
    semver,
    publishedAt,
    channel,
    updatedAt: publishedAt,
    assets,
  };
}

export function desktopManifestObjectPaths({
  channelManifestPath,
  channelRoot,
  publishChannelManifest,
  uploadVersioned,
  version,
}) {
  return [
    ...(uploadVersioned ? [`${channelRoot}/releases/v${version}/latest.json`] : []),
    ...(publishChannelManifest ? [channelManifestPath] : []),
  ];
}

export function signedManifestRequiresObject(signedArtifactUrls, objectUrl) {
  return signedArtifactUrls.has(new URL(objectUrl).toString());
}
