(function () {
  if (/\/device(\.html)?$/.test(location.pathname)) return;
  var ua = navigator.userAgent;
  var mobile = /Android|iPhone|iPod|iPad|Windows Phone|Mobile|Silk|Kindle|Tablet/i.test(ua);
  var ipad = navigator.maxTouchPoints > 1 && /Mac/.test(ua);
  var coarse =
    window.matchMedia &&
    matchMedia("(pointer: coarse)").matches &&
    !matchMedia("(any-pointer: fine)").matches;
  if (mobile || ipad || coarse) location.replace("/device");
})();
