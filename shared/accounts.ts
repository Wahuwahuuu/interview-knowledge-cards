export type Account = { user_id: string; email: string; display_name: string; role: 'admin' | 'member'; local: boolean; needs_password_setup: boolean; via?: 'session' | 'access' | 'local' };
export type UserSummary = { id: string; email: string; display_name: string; role: 'admin' | 'member'; status: 'active' | 'disabled'; created_at: string; updated_at: string };
