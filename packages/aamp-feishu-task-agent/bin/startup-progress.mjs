// Heartbeats belong to interactive terminals only, never persistent logs.
export function startupProgress(label, {stream=process.stderr, interval=15000}={}) {
  const start=Date.now()
  let timer
  if (stream.isTTY) {
    timer=setInterval(()=>{
      stream.write(`\r\x1b[2K[aamp-one-click] ${label}，已等待 ${Math.floor((Date.now()-start)/1000)} 秒...`)
    },interval)
    timer.unref()
  }
  return () => {
    clearInterval(timer)
    if (stream.isTTY) stream.write('\r\x1b[2K')
  }
}
