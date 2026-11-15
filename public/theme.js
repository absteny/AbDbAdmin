try {
  if (localStorage.getItem('abdb-theme')==='dark') document.documentElement.dataset.theme='dark';
} catch {
  // The default stylesheet applies when browser storage is unavailable.
}
