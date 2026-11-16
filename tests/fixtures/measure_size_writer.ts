const mode = process.argv[2]

if (mode === 'exit-before-ready') process.exit(2)

process.on('message', () => {
  if (mode === 'no-stats') return
  process.send?.(JSON.stringify({ max: 1, writes: 2, busy: 3 }), () => process.exit(0))
})
process.send?.('ready')
