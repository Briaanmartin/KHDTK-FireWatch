// Decorative SVG; the Leaflet marker supplies the accessible label.
export const FIRE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 34" width="28" height="34" aria-hidden="true" focusable="false">
  <path d="M15 2c1.2 6-3.1 7.5-3.1 11.4 0 1.4.6 2.6 1.5 3.4 2.6-1.9 4.2-4.4 4.1-7.6 4.1 3.6 8 8 8 13.2C25.5 28.2 20.6 32 14 32S2.5 28.2 2.5 22.4c0-5 3.2-8.5 6.6-11.3-.6 3.2-.2 5.2 1.1 6.8C8.8 10.7 15.7 8.7 15 2Z" fill="currentColor" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M14.8 17.9c.5 3.2-3.6 4.2-3 7.4 1.1-.7 2-1.8 2.2-3 2.1 1.4 3.7 3.1 3.7 5.1 0 1.8-1.6 3-3.7 3s-3.9-1.3-3.9-3.5c0-3.2 3.8-5.1 4.7-9Z" fill="#ffdf75"/>
</svg>`;

export function fireIcon(L, confidence = 'unknown') {
  const level = ['high', 'nominal', 'low', 'unknown'].includes(confidence) ? confidence : 'unknown';
  return L.divIcon({
    className: `hotspot-fire hotspot-fire--${level}`,
    html: FIRE_SVG,
    iconSize: [28, 34],
    iconAnchor: [14, 32],
    popupAnchor: [0, -29],
    tooltipAnchor: [0, -22]
  });
}
