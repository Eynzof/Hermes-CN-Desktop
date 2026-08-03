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

export function assignDesktopAsset(assets, [platform, asset], brandId) {
  if (assets[platform]) {
    throw new Error(
      `Multiple ${platform} installers matched brand ${brandId}: ${assets[platform].fileName}, ${asset.fileName}`,
    );
  }
  assets[platform] = asset;
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
