/** Capture a synchronous workflow-author callback without deciding how its caller should recover. */

export type CallbackResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: string }

export function invokeCallback<T>(label: string, callback: () => T): CallbackResult<T> {
	try {
		return { ok: true, value: callback() }
	} catch (error) {
		return { ok: false, error: `${label} threw: ${error instanceof Error ? error.message : String(error)}` }
	}
}
