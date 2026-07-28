// Promise-shaped wrapper around the browser geolocation callback API —
// shared by RoutePlanner.jsx (generate-time "Use my current location" and
// reopenDay's auto-fill when no starting point is set yet) and
// VisitsCalendar.jsx (the same auto-fill, reached from its own Edit action
// on a planned day).
export function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("This browser can't share your location — enter a start address instead."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'Current location' }),
      () => reject(new Error("Couldn't get your location — enter a start address instead.")),
      { timeout: 10000 }
    );
  });
}
