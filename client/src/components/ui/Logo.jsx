import React from 'react';

// The 4 official brand SVG files live in client/public/brand/ (served as
// static files at these URLs). This map is the ONLY place that knows which
// file goes with which variant name.
const SRC = {
  'full-original': '/brand/logo-full-original.svg', // full color icon + wordmark, for light backgrounds
  'full-reverse': '/brand/logo-full-reverse.svg', // white version, for dark/blue backgrounds
  'full-blackout': '/brand/logo-full-blackout.svg', // solid black version, for print/high-contrast
  icon: '/brand/logo-icon.svg', // icon only (no wordmark) — favicon, empty states, splash
};

// Single source of truth for which logo file renders where. Never recolor/stretch —
// pick the right variant for the background instead. Rendered as a plain <img>
// (not inlined/recreated as JSX) so the original vector file is what actually displays.
export default function Logo({ variant = 'full-original', className = '', style, alt = 'Guardian Angels' }) {
  return <img src={SRC[variant]} alt={alt} className={`logo-img ${className}`} style={style} />;
}
