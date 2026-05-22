import axios from 'axios'

const client = axios.create({
  baseURL: import.meta.env.VITE_API_BASE,
  timeout: 8000,
  headers: {
    'x-api-key': import.meta.env.VITE_API_KEY,
    'Content-Type': 'application/json',
  },
})

client.interceptors.response.use(
  (res) => res.data,
  (err) => {
    const message = err.response?.data?.message || err.message || 'Request failed'
    return Promise.reject(new Error(message))
  }
)

export default client
