export async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function getISTDateStr(): string {
  const now = new Date();
  const options = { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' } as const;
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(now);
  let year = "", month = "", day = "";
  for (const p of parts) {
    if (p.type === 'year') year = p.value;
    if (p.type === 'month') month = p.value;
    if (p.type === 'day') day = p.value;
  }
  return `${year}-${month}-${day}`;
}

export function getISTMinutes(): number {
  const now = new Date();
  const options = { timeZone: 'Asia/Kolkata', hour12: false, hour: 'numeric', minute: 'numeric' } as const;
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(now);
  let hour = 0, minute = 0;
  for (const p of parts) {
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    if (p.type === 'minute') minute = parseInt(p.value, 10);
  }
  return hour * 60 + minute;
}

export function isMarketOpenIST(): boolean {
  const now = new Date();
  const options = { timeZone: 'Asia/Kolkata', weekday: 'short' } as const;
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(now);
  let weekday = '';
  for (const p of parts) {
    if (p.type === 'weekday') weekday = p.value;
  }
  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const mins = getISTMinutes();
  if (mins < 9 * 60 + 15) return false;
  if (mins >= 15 * 60 + 30) return false;

  return true;
}
