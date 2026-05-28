export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      audit_log: {
        Row: {
          action: string;
          actor_user_id: string | null;
          created_at: string;
          id: string;
          merchant_account_id: string;
          payload: Json | null;
          resource_id: string | null;
          resource_type: string | null;
        };
        Insert: {
          action: string;
          actor_user_id?: string | null;
          created_at?: string;
          id?: string;
          merchant_account_id: string;
          payload?: Json | null;
          resource_id?: string | null;
          resource_type?: string | null;
        };
        Update: {
          action?: string;
          actor_user_id?: string | null;
          created_at?: string;
          id?: string;
          merchant_account_id?: string;
          payload?: Json | null;
          resource_id?: string | null;
          resource_type?: string | null;
        };
        Relationships: [];
      };
      merchant_account: {
        Row: {
          country_code: string;
          created_at: string;
          deleted_at: string | null;
          id: string;
          name: string;
          owner_user_id: string;
          plan: 'decouverte' | 'solo' | 'pro';
        };
        Insert: {
          country_code?: string;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          name: string;
          owner_user_id: string;
          plan?: 'decouverte' | 'solo' | 'pro';
        };
        Update: {
          country_code?: string;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          name?: string;
          owner_user_id?: string;
          plan?: 'decouverte' | 'solo' | 'pro';
        };
        Relationships: [];
      };
      merchant_member: {
        Row: {
          created_at: string;
          id: string;
          merchant_account_id: string;
          role: 'owner' | 'manager' | 'agent';
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          merchant_account_id: string;
          role: 'owner' | 'manager' | 'agent';
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          merchant_account_id?: string;
          role?: 'owner' | 'manager' | 'agent';
          user_id?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      is_member_of: {
        Args: { p_merchant_account_id: string };
        Returns: boolean;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
