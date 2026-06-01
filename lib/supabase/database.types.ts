export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: '14.5';
  };
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: {
          extensions?: Json;
          operationName?: string;
          query?: string;
          variables?: Json;
        };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
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
        Relationships: [
          {
            foreignKeyName: 'audit_log_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
        ];
      };
      call_log: {
        Row: {
          agent_user_id: string;
          created_at: string;
          id: string;
          merchant_account_id: string;
          next_action_at: string | null;
          note_fr: string | null;
          order_id: string;
          outcome: string;
        };
        Insert: {
          agent_user_id: string;
          created_at?: string;
          id?: string;
          merchant_account_id: string;
          next_action_at?: string | null;
          note_fr?: string | null;
          order_id: string;
          outcome: string;
        };
        Update: {
          agent_user_id?: string;
          created_at?: string;
          id?: string;
          merchant_account_id?: string;
          next_action_at?: string | null;
          note_fr?: string | null;
          order_id?: string;
          outcome?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'call_log_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'call_log_order_id_fkey';
            columns: ['order_id'];
            isOneToOne: false;
            referencedRelation: 'orders';
            referencedColumns: ['id'];
          },
        ];
      };
      customer: {
        Row: {
          created_at: string;
          email: string | null;
          full_name: string | null;
          id: string;
          merchant_account_id: string;
          phone: string | null;
          shipping_address: Json | null;
          shopify_customer_id: string | null;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          email?: string | null;
          full_name?: string | null;
          id?: string;
          merchant_account_id: string;
          phone?: string | null;
          shipping_address?: Json | null;
          shopify_customer_id?: string | null;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          email?: string | null;
          full_name?: string | null;
          id?: string;
          merchant_account_id?: string;
          phone?: string | null;
          shipping_address?: Json | null;
          shopify_customer_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'customer_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
        ];
      };
      delivery_address: {
        Row: {
          created_at: string;
          customer_id: string | null;
          gps_lat: number | null;
          gps_lng: number | null;
          id: string;
          indications_acces: string | null;
          merchant_account_id: string;
          order_id: string | null;
          quartier_commune: string;
          repere: string | null;
          telephone_alternatif: string | null;
          telephone_principal: string;
          updated_at: string;
          ville: string;
        };
        Insert: {
          created_at?: string;
          customer_id?: string | null;
          gps_lat?: number | null;
          gps_lng?: number | null;
          id?: string;
          indications_acces?: string | null;
          merchant_account_id: string;
          order_id?: string | null;
          quartier_commune: string;
          repere?: string | null;
          telephone_alternatif?: string | null;
          telephone_principal: string;
          updated_at?: string;
          ville?: string;
        };
        Update: {
          created_at?: string;
          customer_id?: string | null;
          gps_lat?: number | null;
          gps_lng?: number | null;
          id?: string;
          indications_acces?: string | null;
          merchant_account_id?: string;
          order_id?: string | null;
          quartier_commune?: string;
          repere?: string | null;
          telephone_alternatif?: string | null;
          telephone_principal?: string;
          updated_at?: string;
          ville?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'delivery_address_customer_id_fkey';
            columns: ['customer_id'];
            isOneToOne: false;
            referencedRelation: 'customer';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'delivery_address_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'delivery_address_order_id_fkey';
            columns: ['order_id'];
            isOneToOne: false;
            referencedRelation: 'orders';
            referencedColumns: ['id'];
          },
        ];
      };
      driver: {
        Row: {
          created_at: string;
          full_name: string;
          id: string;
          is_active: boolean;
          merchant_account_id: string;
          phone: string;
          user_id: string | null;
        };
        Insert: {
          created_at?: string;
          full_name: string;
          id?: string;
          is_active?: boolean;
          merchant_account_id: string;
          phone: string;
          user_id?: string | null;
        };
        Update: {
          created_at?: string;
          full_name?: string;
          id?: string;
          is_active?: boolean;
          merchant_account_id?: string;
          phone?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'driver_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
        ];
      };
      invitation: {
        Row: {
          accepted_at: string | null;
          accepted_by: string | null;
          created_at: string;
          email: string;
          expires_at: string;
          id: string;
          invited_by: string;
          merchant_account_id: string;
          role: string;
          status: string;
          token_hash: string;
          updated_at: string;
        };
        Insert: {
          accepted_at?: string | null;
          accepted_by?: string | null;
          created_at?: string;
          email: string;
          expires_at?: string;
          id?: string;
          invited_by: string;
          merchant_account_id: string;
          role: string;
          status?: string;
          token_hash: string;
          updated_at?: string;
        };
        Update: {
          accepted_at?: string | null;
          accepted_by?: string | null;
          created_at?: string;
          email?: string;
          expires_at?: string;
          id?: string;
          invited_by?: string;
          merchant_account_id?: string;
          role?: string;
          status?: string;
          token_hash?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'invitation_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
        ];
      };
      merchant_account: {
        Row: {
          country_code: string;
          created_at: string;
          deleted_at: string | null;
          id: string;
          name: string;
          onboarded_at: string | null;
          owner_full_name: string | null;
          owner_user_id: string;
          plan: string;
          whatsapp_e164: string | null;
        };
        Insert: {
          country_code?: string;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          name: string;
          onboarded_at?: string | null;
          owner_full_name?: string | null;
          owner_user_id: string;
          plan?: string;
          whatsapp_e164?: string | null;
        };
        Update: {
          country_code?: string;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          name?: string;
          onboarded_at?: string | null;
          owner_full_name?: string | null;
          owner_user_id?: string;
          plan?: string;
          whatsapp_e164?: string | null;
        };
        Relationships: [];
      };
      merchant_member: {
        Row: {
          created_at: string;
          id: string;
          merchant_account_id: string;
          role: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          merchant_account_id: string;
          role: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          merchant_account_id?: string;
          role?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'merchant_member_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
        ];
      };
      order_state_transition: {
        Row: {
          actor_user_id: string;
          created_at: string;
          from_status: string | null;
          id: string;
          merchant_account_id: string;
          note: string | null;
          order_id: string;
          to_status: string;
        };
        Insert: {
          actor_user_id: string;
          created_at?: string;
          from_status?: string | null;
          id?: string;
          merchant_account_id: string;
          note?: string | null;
          order_id: string;
          to_status: string;
        };
        Update: {
          actor_user_id?: string;
          created_at?: string;
          from_status?: string | null;
          id?: string;
          merchant_account_id?: string;
          note?: string | null;
          order_id?: string;
          to_status?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'order_state_transition_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'order_state_transition_order_id_fkey';
            columns: ['order_id'];
            isOneToOne: false;
            referencedRelation: 'orders';
            referencedColumns: ['id'];
          },
        ];
      };
      orders: {
        Row: {
          assigned_driver_id: string | null;
          cod_status: string;
          created_at: string;
          created_at_shopify: string | null;
          currency: string;
          customer_id: string | null;
          financial_status: string | null;
          fulfillment_status: string | null;
          id: string;
          items_summary: Json | null;
          merchant_account_id: string;
          order_number: string | null;
          shipping_address: Json | null;
          shop_id: string | null;
          shopify_order_id: string | null;
          total_amount: number;
          updated_at: string;
        };
        Insert: {
          assigned_driver_id?: string | null;
          cod_status?: string;
          created_at?: string;
          created_at_shopify?: string | null;
          currency?: string;
          customer_id?: string | null;
          financial_status?: string | null;
          fulfillment_status?: string | null;
          id?: string;
          items_summary?: Json | null;
          merchant_account_id: string;
          order_number?: string | null;
          shipping_address?: Json | null;
          shop_id?: string | null;
          shopify_order_id?: string | null;
          total_amount?: number;
          updated_at?: string;
        };
        Update: {
          assigned_driver_id?: string | null;
          cod_status?: string;
          created_at?: string;
          created_at_shopify?: string | null;
          currency?: string;
          customer_id?: string | null;
          financial_status?: string | null;
          fulfillment_status?: string | null;
          id?: string;
          items_summary?: Json | null;
          merchant_account_id?: string;
          order_number?: string | null;
          shipping_address?: Json | null;
          shop_id?: string | null;
          shopify_order_id?: string | null;
          total_amount?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'orders_customer_id_fkey';
            columns: ['customer_id'];
            isOneToOne: false;
            referencedRelation: 'customer';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'orders_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'orders_shop_id_fkey';
            columns: ['shop_id'];
            isOneToOne: false;
            referencedRelation: 'shop';
            referencedColumns: ['id'];
          },
        ];
      };
      shop: {
        Row: {
          access_token_encrypted: string;
          access_token_expires_at: string | null;
          id: string;
          installed_at: string;
          merchant_account_id: string;
          refresh_token_encrypted: string | null;
          refresh_token_expires_at: string | null;
          scopes: string;
          shop_domain: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          access_token_encrypted: string;
          access_token_expires_at?: string | null;
          id?: string;
          installed_at?: string;
          merchant_account_id: string;
          refresh_token_encrypted?: string | null;
          refresh_token_expires_at?: string | null;
          scopes: string;
          shop_domain: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          access_token_encrypted?: string;
          access_token_expires_at?: string | null;
          id?: string;
          installed_at?: string;
          merchant_account_id?: string;
          refresh_token_encrypted?: string | null;
          refresh_token_expires_at?: string | null;
          scopes?: string;
          shop_domain?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'shop_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: true;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
        ];
      };
      webhook_event: {
        Row: {
          id: string;
          processed: boolean;
          received_at: string;
          shop_domain: string | null;
          shopify_webhook_id: string;
          topic: string;
        };
        Insert: {
          id?: string;
          processed?: boolean;
          received_at?: string;
          shop_domain?: string | null;
          shopify_webhook_id: string;
          topic: string;
        };
        Update: {
          id?: string;
          processed?: boolean;
          received_at?: string;
          shop_domain?: string | null;
          shopify_webhook_id?: string;
          topic?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      accept_invitation: { Args: { p_token: string }; Returns: Json };
      current_member_role: { Args: { p_account: string }; Returns: string };
      get_customer_reliability: {
        Args: { p_customer_id: string; p_merchant_id: string };
        Returns: {
          attempts_weighted: number;
          cancelled_count: number;
          confirm_score: number;
          confirmed_weighted: number;
          customer_id: string;
          decided: number;
          delivered_count: number;
          delivered_lifetime: number;
          delivered_weighted: number;
          delivery_score: number;
          email: string;
          flag_cancels_often: boolean;
          flag_confirms_then_refuses: boolean;
          flag_hard_to_reach: boolean;
          full_name: string;
          is_provisional: boolean;
          no_response_weighted: number;
          order_count: number;
          phone: string;
          refused_count: number;
          refused_weighted: number;
          score: number;
          tier: string;
        }[];
      };
      get_dashboard_kpi: { Args: { p_merchant_id: string }; Returns: Json };
      is_member_of: {
        Args: { p_merchant_account_id: string };
        Returns: boolean;
      };
      list_customer_reliability: {
        Args: {
          p_limit?: number;
          p_merchant_id: string;
          p_offset?: number;
          p_search?: string;
          p_sort_by_risk?: boolean;
        };
        Returns: {
          attempts_weighted: number;
          cancelled_count: number;
          confirm_score: number;
          confirmed_weighted: number;
          customer_id: string;
          decided: number;
          delivered_count: number;
          delivered_lifetime: number;
          delivered_weighted: number;
          delivery_score: number;
          email: string;
          flag_cancels_often: boolean;
          flag_confirms_then_refuses: boolean;
          flag_hard_to_reach: boolean;
          full_name: string;
          is_provisional: boolean;
          no_response_weighted: number;
          order_count: number;
          phone: string;
          refused_count: number;
          refused_weighted: number;
          score: number;
          tier: string;
        }[];
      };
      transition_order: {
        Args: {
          p_actor: string;
          p_note?: string;
          p_order_id: string;
          p_to: string;
        };
        Returns: string;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema['Tables']
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema['Tables']
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema['Enums']
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema['CompositeTypes']
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const;
