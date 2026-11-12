export function appendRobotPhotos(current, incoming) {
  if (!current?.order?.id || incoming?.order?.id !== current.order.id || incoming.order.revision !== current.order.revision) {
    throw Error('Der Auftrag wurde inzwischen geändert. Bitte die Details neu laden.');
  }
  if (!Array.isArray(incoming.photos)) throw Error('Die nächste Bilderseite wurde nicht vollständig geladen.');
  if (incoming.photosNextCursor && incoming.photosNextCursor === current.photosNextCursor) {
    throw Error('Die nächste Bilderseite konnte nicht bestätigt werden. Bitte die Details neu laden.');
  }
  const photos = new Map((current.photos || []).map(photo => [photo.id, photo]));
  for (const photo of incoming.photos) {
    if (!photo?.id) throw Error('Eine Bildkennung fehlt. Bitte die Details neu laden.');
    photos.set(photo.id, photo);
  }
  return {...current, photos: [...photos.values()], photosNextCursor: incoming.photosNextCursor || null};
}
