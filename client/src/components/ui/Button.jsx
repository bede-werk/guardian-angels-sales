import React from 'react';

// One button system used everywhere, instead of every screen hand-writing its
// own <button className="btn ..."> markup. All the actual visual styling
// (colors, padding, hover states) lives in the ".btn" CSS rules in styles.css —
// this component just picks which CSS classes apply.
//   variant: primary (default) | secondary | ghost | danger
//   size: default | small | big
// Any other prop (onClick, disabled, type, title, ...) passes straight through
// to the underlying <button> via {...props}.
export default function Button({ variant = 'primary', size, className = '', children, ...props }) {
  const variantClass = variant === 'primary' ? '' : variant; // primary is the plain ".btn" look, no extra class needed
  const sizeClass = size ? size : '';
  return (
    <button className={`btn ${variantClass} ${sizeClass} ${className}`.trim().replace(/\s+/g, ' ')} {...props}>
      {children}
    </button>
  );
}
