const to = Math.floor(Date.now() / 1000);
const from = to - 7 * 24 * 3600;
fetch(`https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history?symbol=APOLLOTYRE&resolution=5&from=${from}&to=${to}&countback=600&currencyCode=INR`)
  .then(r => r.json())
  .then(data => {
    let pdh = 0;
    data.t.forEach((t, i) => {
      if (new Date(t*1000).toISOString().startsWith('2026-07-03')) {
        pdh = Math.max(pdh, data.h[i]);
      }
    });
    console.log('MC PDH on July 3:', pdh);
  });
