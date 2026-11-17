// Applies the saved interface style before the first paint (a classic, blocking script in <head>),
// so a page never flashes the default look first. The list of styles and the picker live in theme.js.
(function () {
  try {
    var id = JSON.parse(localStorage.getItem('te.ui') || 'null');
    if (typeof id === 'string' && /^[a-z]{1,16}$/.test(id) && id !== 'default') document.documentElement.dataset.ui = id;
  } catch (e) {
    /* storage blocked or bad value: keep the default look */
  }
})();
