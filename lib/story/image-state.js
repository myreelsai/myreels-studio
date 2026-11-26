export function variantHasImage(variant) {
  if (!variant || typeof variant !== 'object') return false;
  return Boolean(
    String(variant.imageUrl || '').trim() ||
      String(variant.userFileId || '').trim() ||
      String(variant.thumbnailUrl || '').trim()
  );
}
