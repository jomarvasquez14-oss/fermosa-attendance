import type {
  AdminUsersRequest,
  AdminUsersResponse,
  CreateEmployeeInput,
} from '@fermosa/shared';
import { supabase } from './supabase';

async function callAdminUsers(req: AdminUsersRequest): Promise<AdminUsersResponse> {
  const { data, error } = await supabase.functions.invoke('admin-users', { body: req });
  if (error) {
    // FunctionsHttpError carries the response; surface the server's message.
    let message = error.message;
    try {
      const body = await (error as { context?: Response }).context?.json();
      if (body?.error) message = body.error;
    } catch {
      // keep the generic message
    }
    return { ok: false, error: message };
  }
  return data as AdminUsersResponse;
}

export function createEmployee(input: CreateEmployeeInput) {
  return callAdminUsers({ action: 'create', input });
}

export function resetPassword(userId: string, newPassword: string) {
  return callAdminUsers({ action: 'reset_password', user_id: userId, new_password: newPassword });
}

/** Clear a user's enrolled 2FA factors (super_admin only) — lost-device recovery. */
export function resetMfa(userId: string) {
  return callAdminUsers({ action: 'mfa_reset', user_id: userId });
}

export async function setEmployeePin(employeeId: string, pin: string) {
  const { error } = await supabase.rpc('set_employee_pin', {
    p_employee_id: employeeId,
    p_pin: pin,
  });
  return { ok: !error, error: error?.message };
}

export function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}
