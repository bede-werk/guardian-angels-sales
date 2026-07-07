import React from 'react';

// One button system used everywhere. variant: primary (default) | secondary | ghost | danger.
// size: default | small | big.
export default function Button({ variant = 'primary', size, className = '', children, ...props }) {
  const variantClass = variant === 'primary' ? '' : variant;
  const sizeClass = size ? size : '';
  return (
    <button className={`btn ${variantClass} ${sizeClass} ${className}`.trim().replace(/\s+/g, ' ')} {...props}>
      {children}
    </button>
  );
}
