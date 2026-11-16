const mode = process.argv[2]

if (mode === 'exit-before-ready') process.exit(2)

if (mode === 'delayed-close') process.on('SIGTERM', () => {})

process.on('message', (message) => {
  if (mode === 'delayed-close' && message === 'close-now') {
    process.exit(0)
    return
  }
  if (message !== 'stop') return
  if (mode === 'no-stats') return
  if (mode === 'bad-stats') {
    process.send?.('{"max":null,"writes":1.5,"busy":-1}', () => process.exit(0))
    return
  }
  if (mode === 'delayed-close') {
    process.send?.(JSON.stringify({ max: 1, writes: 2, busy: 3 }))
    return
  }
  process.send?.(JSON.stringify({ max: 1, writes: 2, busy: 3 }), () => process.exit(0))
})
process.send?.('ready')
