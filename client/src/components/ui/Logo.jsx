import React from 'react';

const SRC = {
  'full-original': '/brand/logo-full-original.svg',
  'full-reverse': '/brand/logo-full-reverse.svg',
  'full-blackout': '/brand/logo-full-blackout.svg',
  icon: '/brand/logo-icon.svg',
};

// Single source of truth for which logo file renders where. Never recolor/stretch —
// pick the right variant for the background instead.
export default function Logo({ variant = 'full-original', className = '', style, alt = 'Guardian Angels' }) {
  return <img src={SRC[variant]} alt={alt} className={`logo-img ${className}`} style={style} />;
}
