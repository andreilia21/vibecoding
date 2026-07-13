import { useState } from 'react'
import './App.css'

export default function App() {
  const [count, setCount] = useState(0)

  return (
    <main>
      <h1>React Counter</h1>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        Count: {count}
      </button>
    </main>
  )
}

