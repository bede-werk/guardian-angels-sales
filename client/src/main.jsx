// Entry point for the React app — Vite loads this file first (see index.html's
// <script type="module" src="/src/main.jsx">). It just mounts <App /> into the
// #root div and pulls in the global stylesheet.
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
