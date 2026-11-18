// Keeps one WebSocket open, asks for a quote every 100ms, and prints each time the answer changes.
// Usage: node examples/ws-watch.mjs <port> <seconds>
const [port, seconds] = process.argv.slice(2).map(Number);
const sock = new WebSocket(`ws://localhost:${port}/live`);
let last;
sock.onopen = () => {
  console.log(`[ws client] connected to :${port}/live`);
  const timer = setInterval(() => sock.send(JSON.stringify({ qty: 1, price: 1 })), 100);
  setTimeout(() => (clearInterval(timer), sock.close()), seconds * 1000);
};
sock.onmessage = (e) => {
  if (e.data !== last) console.log(`[ws client] same connection, quote for qty 1 @ 1 is now ${e.data}`);
  last = e.data;
};
sock.onclose = (e) => console.log(`[ws client] closed (${e.code}${e.reason ? `: ${e.reason}` : ""})`);
