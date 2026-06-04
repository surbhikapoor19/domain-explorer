import '@testing-library/jest-dom';

// Plotly uses mapbox-gl which calls window.URL.createObjectURL in jsdom — stub it.
if (!window.URL.createObjectURL) {
  window.URL.createObjectURL = () => '';
}
