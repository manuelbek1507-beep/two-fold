// IndexedDB storage for this device's E2EE identity. The private key is a NON-EXTRACTABLE CryptoKey:
// scripts can use it but cannot read its bytes. Records are namespaced by user id.
import type { PublicJwk } from './crypto'

export interface LocalDevice { deviceId: string; privateKey: CryptoKey; publicJwk: PublicJwk }
const DB = '2fold-keys', STORE = 'devices'

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1)
    r.onupgradeneeded = () => r.result.createObjectStore(STORE)
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise((res, rej) => {
    const r = fn(db.transaction(STORE, mode).objectStore(STORE))
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}
export const loadLocalDevice = (userId: string) => tx<LocalDevice | undefined>('readonly', (s) => s.get(userId))
export const saveLocalDevice = (userId: string, d: LocalDevice) => tx('readwrite', (s) => s.put(d, userId))
export const eraseLocalDevice = (userId: string) => tx('readwrite', (s) => s.delete(userId))
