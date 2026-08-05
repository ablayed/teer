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
          next_state: string | null;
          payload: Json | null;
          prior_state: string | null;
          reason: string | null;
          resource_id: string | null;
          resource_type: string | null;
          source: string | null;
        };
        Insert: {
          action: string;
          actor_user_id?: string | null;
          created_at?: string;
          id?: string;
          merchant_account_id: string;
          next_state?: string | null;
          payload?: Json | null;
          prior_state?: string | null;
          reason?: string | null;
          resource_id?: string | null;
          resource_type?: string | null;
          source?: string | null;
        };
        Update: {
          action?: string;
          actor_user_id?: string | null;
          created_at?: string;
          id?: string;
          merchant_account_id?: string;
          next_state?: string | null;
          payload?: Json | null;
          prior_state?: string | null;
          reason?: string | null;
          resource_id?: string | null;
          resource_type?: string | null;
          source?: string | null;
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
      cash_settlement: {
        Row: {
          amount_received_minor: number;
          client_request_id: string;
          created_at: string;
          created_by: string;
          driver_id: string;
          id: string;
          merchant_account_id: string;
          method: string;
          note: string | null;
          settled_at: string;
        };
        Insert: {
          amount_received_minor: number;
          client_request_id: string;
          created_at?: string;
          created_by: string;
          driver_id: string;
          id?: string;
          merchant_account_id: string;
          method: string;
          note?: string | null;
          settled_at?: string;
        };
        Update: {
          amount_received_minor?: number;
          client_request_id?: string;
          created_at?: string;
          created_by?: string;
          driver_id?: string;
          id?: string;
          merchant_account_id?: string;
          method?: string;
          note?: string | null;
          settled_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'cash_settlement_driver_id_fkey';
            columns: ['driver_id'];
            isOneToOne: false;
            referencedRelation: 'driver';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'cash_settlement_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
        ];
      };
      customer: {
        Row: {
          address: Json | null;
          created_at: string;
          first_name: string | null;
          full_name: string | null;
          id: string;
          last_name: string | null;
          merchant_account_id: string;
          phone: string | null;
          phone_e164: string | null;
          shipping_address: Json | null;
          shopify_customer_gids: Json;
          shopify_customer_id: string | null;
          shopify_last_activity_at: string | null;
          source: string;
          updated_at: string;
        };
        Insert: {
          address?: Json | null;
          created_at?: string;
          first_name?: string | null;
          full_name?: string | null;
          id?: string;
          last_name?: string | null;
          merchant_account_id: string;
          phone?: string | null;
          phone_e164?: string | null;
          shipping_address?: Json | null;
          shopify_customer_gids?: Json;
          shopify_customer_id?: string | null;
          shopify_last_activity_at?: string | null;
          source?: string;
          updated_at?: string;
        };
        Update: {
          address?: Json | null;
          created_at?: string;
          first_name?: string | null;
          full_name?: string | null;
          id?: string;
          last_name?: string | null;
          merchant_account_id?: string;
          phone?: string | null;
          phone_e164?: string | null;
          shipping_address?: Json | null;
          shopify_customer_gids?: Json;
          shopify_customer_id?: string | null;
          shopify_last_activity_at?: string | null;
          source?: string;
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
      shopify_customer_redaction_tombstone: {
        Row: {
          created_at: string;
          expires_at: string;
          id: string;
          merchant_account_id: string;
          redacted_at: string;
          shop_id: string;
          shopify_customer_id: string;
        };
        Insert: {
          created_at?: string;
          expires_at: string;
          id?: string;
          merchant_account_id: string;
          redacted_at?: string;
          shop_id: string;
          shopify_customer_id: string;
        };
        Update: {
          created_at?: string;
          expires_at?: string;
          id?: string;
          merchant_account_id?: string;
          redacted_at?: string;
          shop_id?: string;
          shopify_customer_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'shopify_customer_redaction_tombstone_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'shopify_customer_redaction_tombstone_shop_id_fkey';
            columns: ['shop_id'];
            isOneToOne: false;
            referencedRelation: 'shop';
            referencedColumns: ['id'];
          },
        ];
      };
      shopify_dsar_artifact: {
        Row: {
          byte_size: number | null;
          completed_at: string | null;
          created_at: string;
          expires_at: string;
          id: string;
          merchant_account_id: string;
          purge_attempt_count: number;
          purge_last_attempt_at: string | null;
          purge_last_error_code: string | null;
          purge_last_success_at: string | null;
          purge_lease_until: string | null;
          purge_next_attempt_at: string | null;
          purged_at: string | null;
          shop_id: string;
          status: string;
          storage_bucket: string;
          storage_path: string;
          webhook_event_id: string;
        };
        Insert: {
          byte_size?: number | null;
          completed_at?: string | null;
          created_at?: string;
          expires_at: string;
          id?: string;
          merchant_account_id: string;
          purge_attempt_count?: number;
          purge_last_attempt_at?: string | null;
          purge_last_error_code?: string | null;
          purge_last_success_at?: string | null;
          purge_lease_until?: string | null;
          purge_next_attempt_at?: string | null;
          purged_at?: string | null;
          shop_id: string;
          status?: string;
          storage_bucket?: string;
          storage_path: string;
          webhook_event_id: string;
        };
        Update: {
          byte_size?: number | null;
          completed_at?: string | null;
          created_at?: string;
          expires_at?: string;
          id?: string;
          merchant_account_id?: string;
          purge_attempt_count?: number;
          purge_last_attempt_at?: string | null;
          purge_last_error_code?: string | null;
          purge_last_success_at?: string | null;
          purge_lease_until?: string | null;
          purge_next_attempt_at?: string | null;
          purged_at?: string | null;
          shop_id?: string;
          status?: string;
          storage_bucket?: string;
          storage_path?: string;
          webhook_event_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'shopify_dsar_artifact_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'shopify_dsar_artifact_shop_id_fkey';
            columns: ['shop_id'];
            isOneToOne: false;
            referencedRelation: 'shop';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'shopify_dsar_artifact_webhook_event_id_fkey';
            columns: ['webhook_event_id'];
            isOneToOne: false;
            referencedRelation: 'webhook_event';
            referencedColumns: ['id'];
          },
        ];
      };
      shopify_pcd_purge_run: {
        Row: {
          completed_at: string | null;
          error_code: string | null;
          id: string;
          last_attempt_at: string;
          last_success_at: string | null;
          limit_requested: number;
          mode: string;
          started_at: string;
          status: string;
          summary: Json;
        };
        Insert: {
          completed_at?: string | null;
          error_code?: string | null;
          id?: string;
          last_attempt_at?: string;
          last_success_at?: string | null;
          limit_requested: number;
          mode: string;
          started_at?: string;
          status?: string;
          summary?: Json;
        };
        Update: {
          completed_at?: string | null;
          error_code?: string | null;
          id?: string;
          last_attempt_at?: string;
          last_success_at?: string | null;
          limit_requested?: number;
          mode?: string;
          started_at?: string;
          status?: string;
          summary?: Json;
        };
        Relationships: [];
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
      expense: {
        Row: {
          amount_minor: number;
          category_id: string;
          created_at: string;
          created_by: string;
          free_text_category: string | null;
          id: string;
          merchant_account_id: string;
          note: string | null;
          spent_at: string;
          updated_at: string;
        };
        Insert: {
          amount_minor: number;
          category_id: string;
          created_at?: string;
          created_by: string;
          free_text_category?: string | null;
          id?: string;
          merchant_account_id: string;
          note?: string | null;
          spent_at: string;
          updated_at?: string;
        };
        Update: {
          amount_minor?: number;
          category_id?: string;
          created_at?: string;
          created_by?: string;
          free_text_category?: string | null;
          id?: string;
          merchant_account_id?: string;
          note?: string | null;
          spent_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'expense_category_id_fkey';
            columns: ['category_id'];
            isOneToOne: false;
            referencedRelation: 'expense_category';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'expense_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
        ];
      };
      expense_category: {
        Row: {
          code: string;
          created_at: string;
          id: string;
          is_active: boolean;
          is_system: boolean;
          label_fr: string;
          merchant_account_id: string;
          sort_order: number;
          syscohada_account: string | null;
        };
        Insert: {
          code: string;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          is_system?: boolean;
          label_fr: string;
          merchant_account_id: string;
          sort_order?: number;
          syscohada_account?: string | null;
        };
        Update: {
          code?: string;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          is_system?: boolean;
          label_fr?: string;
          merchant_account_id?: string;
          sort_order?: number;
          syscohada_account?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'expense_category_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
        ];
      };
      feedback: {
        Row: {
          actor_user_id: string | null;
          category: string;
          created_at: string;
          id: string;
          merchant_account_id: string;
          message: string;
          page_context: string | null;
          user_agent: string | null;
        };
        Insert: {
          actor_user_id?: string | null;
          category: string;
          created_at?: string;
          id?: string;
          merchant_account_id: string;
          message: string;
          page_context?: string | null;
          user_agent?: string | null;
        };
        Update: {
          actor_user_id?: string | null;
          category?: string;
          created_at?: string;
          id?: string;
          merchant_account_id?: string;
          message?: string;
          page_context?: string | null;
          user_agent?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'feedback_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
        ];
      };
      ia_conversation: {
        Row: {
          created_at: string;
          id: string;
          merchant_account_id: string;
          summary: string | null;
          title: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          merchant_account_id: string;
          summary?: string | null;
          title?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          merchant_account_id?: string;
          summary?: string | null;
          title?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'ia_conversation_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
        ];
      };
      ia_faq: {
        Row: {
          answer_fr: string;
          created_at: string;
          id: string;
          is_active: boolean;
          min_role: string;
          question_fr: string;
          sort_order: number;
        };
        Insert: {
          answer_fr: string;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          min_role?: string;
          question_fr: string;
          sort_order?: number;
        };
        Update: {
          answer_fr?: string;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          min_role?: string;
          question_fr?: string;
          sort_order?: number;
        };
        Relationships: [];
      };
      ia_message: {
        Row: {
          content: string;
          conversation_id: string;
          created_at: string;
          id: string;
          merchant_account_id: string;
          role: string;
        };
        Insert: {
          content: string;
          conversation_id: string;
          created_at?: string;
          id?: string;
          merchant_account_id: string;
          role: string;
        };
        Update: {
          content?: string;
          conversation_id?: string;
          created_at?: string;
          id?: string;
          merchant_account_id?: string;
          role?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'ia_message_conversation_id_fkey';
            columns: ['conversation_id'];
            isOneToOne: false;
            referencedRelation: 'ia_conversation';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'ia_message_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
        ];
      };
      ia_tool_audit: {
        Row: {
          allowed: boolean;
          conversation_id: string | null;
          created_at: string;
          denied_reason: string | null;
          id: string;
          latency_ms: number | null;
          merchant_account_id: string;
          tool_args: Json;
          tool_name: string;
          user_id: string;
          user_role: string;
        };
        Insert: {
          allowed: boolean;
          conversation_id?: string | null;
          created_at?: string;
          denied_reason?: string | null;
          id?: string;
          latency_ms?: number | null;
          merchant_account_id: string;
          tool_args?: Json;
          tool_name: string;
          user_id: string;
          user_role: string;
        };
        Update: {
          allowed?: boolean;
          conversation_id?: string | null;
          created_at?: string;
          denied_reason?: string | null;
          id?: string;
          latency_ms?: number | null;
          merchant_account_id?: string;
          tool_args?: Json;
          tool_name?: string;
          user_id?: string;
          user_role?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'ia_tool_audit_conversation_id_fkey';
            columns: ['conversation_id'];
            isOneToOne: false;
            referencedRelation: 'ia_conversation';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'ia_tool_audit_merchant_account_id_fkey';
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
      legal_documents: {
        Row: {
          body_url: string | null;
          content_hash: string;
          id: string;
          is_current: boolean;
          published_at: string;
          type: string;
          version: string;
        };
        Insert: {
          body_url?: string | null;
          content_hash: string;
          id?: string;
          is_current?: boolean;
          published_at?: string;
          type: string;
          version: string;
        };
        Update: {
          body_url?: string | null;
          content_hash?: string;
          id?: string;
          is_current?: boolean;
          published_at?: string;
          type?: string;
          version?: string;
        };
        Relationships: [];
      };
      manual_order_number_counter: {
        Row: {
          merchant_account_id: string;
          next_value: number;
        };
        Insert: {
          merchant_account_id: string;
          next_value?: number;
        };
        Update: {
          merchant_account_id?: string;
          next_value?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'manual_order_number_counter_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: true;
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
      merchant_settings: {
        Row: {
          cogs_known: boolean;
          default_delivery_cost_minor: number;
          default_low_stock_threshold: number | null;
          free_money_fee_bps: number;
          import_vat_recoverable: boolean;
          merchant_account_id: string;
          merchant_levy_bps: number;
          orange_money_fee_bps: number;
          transfer_tax_bps: number;
          transfer_tax_cap_minor: number;
          updated_at: string;
          wave_fee_bps: number;
        };
        Insert: {
          cogs_known?: boolean;
          default_delivery_cost_minor?: number;
          default_low_stock_threshold?: number | null;
          free_money_fee_bps?: number;
          import_vat_recoverable?: boolean;
          merchant_account_id: string;
          merchant_levy_bps?: number;
          orange_money_fee_bps?: number;
          transfer_tax_bps?: number;
          transfer_tax_cap_minor?: number;
          updated_at?: string;
          wave_fee_bps?: number;
        };
        Update: {
          cogs_known?: boolean;
          default_delivery_cost_minor?: number;
          default_low_stock_threshold?: number | null;
          free_money_fee_bps?: number;
          import_vat_recoverable?: boolean;
          merchant_account_id?: string;
          merchant_levy_bps?: number;
          orange_money_fee_bps?: number;
          transfer_tax_bps?: number;
          transfer_tax_cap_minor?: number;
          updated_at?: string;
          wave_fee_bps?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'merchant_settings_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: true;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
        ];
      };
      order_line: {
        Row: {
          created_at: string;
          id: string;
          match_status: string;
          merchant_account_id: string;
          order_id: string;
          product_id: string | null;
          qty: number;
          raw_shopify_product_id: string | null;
          raw_shopify_variant_id: string | null;
          raw_sku: string | null;
          raw_title: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          match_status: string;
          merchant_account_id: string;
          order_id: string;
          product_id?: string | null;
          qty: number;
          raw_shopify_product_id?: string | null;
          raw_shopify_variant_id?: string | null;
          raw_sku?: string | null;
          raw_title: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          match_status?: string;
          merchant_account_id?: string;
          order_id?: string;
          product_id?: string | null;
          qty?: number;
          raw_shopify_product_id?: string | null;
          raw_shopify_variant_id?: string | null;
          raw_sku?: string | null;
          raw_title?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'order_line_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'order_line_order_id_fkey';
            columns: ['order_id'];
            isOneToOne: false;
            referencedRelation: 'orders';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'order_line_product_id_fkey';
            columns: ['product_id'];
            isOneToOne: false;
            referencedRelation: 'product';
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
          attempt_count: number | null;
          call_confirmed_at: string | null;
          call_state: string | null;
          cancel_reason: string | null;
          cancel_reasons: string[] | null;
          cart_locally_modified_at: string | null;
          cash_collectable_minor: number | null;
          cash_collected_at: string | null;
          cash_state: string | null;
          cod_status: string;
          created_at: string;
          created_at_shopify: string | null;
          currency: string;
          customer_id: string | null;
          delivery_fee_minor: number;
          delivery_state: string | null;
          financial_status: string | null;
          fulfillment_status: string | null;
          id: string;
          items_summary: Json | null;
          merchant_account_id: string;
          next_action_at: string | null;
          next_contact_at: string | null;
          note: string | null;
          order_number: string | null;
          order_state: string | null;
          pcd_finalized_at: string | null;
          payment_channel_at_delivery: string | null;
          returned_at: string | null;
          scheduled_for: string | null;
          shipping_address: Json | null;
          shop_id: string | null;
          shopify_cancelled_at: string | null;
          shopify_financial_status: string | null;
          shopify_fulfillment_status: string | null;
          shopify_line_item_attributes: Json | null;
          shopify_order_attributes: Json | null;
          shopify_order_id: string | null;
          shopify_updated_at: string | null;
          sort_at: string | null;
          source: string | null;
          total_amount: number;
          updated_at: string;
        };
        Insert: {
          assigned_driver_id?: string | null;
          attempt_count?: number | null;
          call_confirmed_at?: string | null;
          call_state?: string | null;
          cancel_reason?: string | null;
          cancel_reasons?: string[] | null;
          cart_locally_modified_at?: string | null;
          cash_collectable_minor?: number | null;
          cash_collected_at?: string | null;
          cash_state?: string | null;
          cod_status?: string;
          created_at?: string;
          created_at_shopify?: string | null;
          currency?: string;
          customer_id?: string | null;
          delivery_fee_minor?: number;
          delivery_state?: string | null;
          financial_status?: string | null;
          fulfillment_status?: string | null;
          id?: string;
          items_summary?: Json | null;
          merchant_account_id: string;
          next_action_at?: string | null;
          next_contact_at?: string | null;
          note?: string | null;
          order_number?: string | null;
          order_state?: string | null;
          pcd_finalized_at?: string | null;
          payment_channel_at_delivery?: string | null;
          returned_at?: string | null;
          scheduled_for?: string | null;
          shipping_address?: Json | null;
          shop_id?: string | null;
          shopify_cancelled_at?: string | null;
          shopify_financial_status?: string | null;
          shopify_fulfillment_status?: string | null;
          shopify_line_item_attributes?: Json | null;
          shopify_order_attributes?: Json | null;
          shopify_order_id?: string | null;
          shopify_updated_at?: string | null;
          sort_at?: string | null;
          source?: string | null;
          total_amount?: number;
          updated_at?: string;
        };
        Update: {
          assigned_driver_id?: string | null;
          attempt_count?: number | null;
          call_confirmed_at?: string | null;
          call_state?: string | null;
          cancel_reason?: string | null;
          cancel_reasons?: string[] | null;
          cart_locally_modified_at?: string | null;
          cash_collectable_minor?: number | null;
          cash_collected_at?: string | null;
          cash_state?: string | null;
          cod_status?: string;
          created_at?: string;
          created_at_shopify?: string | null;
          currency?: string;
          customer_id?: string | null;
          delivery_fee_minor?: number;
          delivery_state?: string | null;
          financial_status?: string | null;
          fulfillment_status?: string | null;
          id?: string;
          items_summary?: Json | null;
          merchant_account_id?: string;
          next_action_at?: string | null;
          next_contact_at?: string | null;
          note?: string | null;
          order_number?: string | null;
          order_state?: string | null;
          pcd_finalized_at?: string | null;
          payment_channel_at_delivery?: string | null;
          returned_at?: string | null;
          scheduled_for?: string | null;
          shipping_address?: Json | null;
          shop_id?: string | null;
          shopify_cancelled_at?: string | null;
          shopify_financial_status?: string | null;
          shopify_fulfillment_status?: string | null;
          shopify_line_item_attributes?: Json | null;
          shopify_order_attributes?: Json | null;
          shopify_order_id?: string | null;
          shopify_updated_at?: string | null;
          sort_at?: string | null;
          source?: string | null;
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
      product: {
        Row: {
          created_at: string;
          id: string;
          is_active: boolean;
          is_bundle: boolean;
          merchant_account_id: string;
          shopify_product_id: string | null;
          shopify_variant_id: string | null;
          sku: string | null;
          title: string;
          unit_cost: number;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          is_active?: boolean;
          is_bundle?: boolean;
          merchant_account_id: string;
          shopify_product_id?: string | null;
          shopify_variant_id?: string | null;
          sku?: string | null;
          title: string;
          unit_cost?: number;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_active?: boolean;
          is_bundle?: boolean;
          merchant_account_id?: string;
          shopify_product_id?: string | null;
          shopify_variant_id?: string | null;
          sku?: string | null;
          title?: string;
          unit_cost?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'product_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
        ];
      };
      product_bundle_component: {
        Row: {
          bundle_product_id: string;
          component_product_id: string;
          created_at: string;
          id: string;
          merchant_account_id: string;
          quantity: number;
          updated_at: string;
        };
        Insert: {
          bundle_product_id: string;
          component_product_id: string;
          created_at?: string;
          id?: string;
          merchant_account_id: string;
          quantity: number;
          updated_at?: string;
        };
        Update: {
          bundle_product_id?: string;
          component_product_id?: string;
          created_at?: string;
          id?: string;
          merchant_account_id?: string;
          quantity?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'product_bundle_component_bundle_product_id_fkey';
            columns: ['bundle_product_id'];
            isOneToOne: false;
            referencedRelation: 'product';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'product_bundle_component_component_product_id_fkey';
            columns: ['component_product_id'];
            isOneToOne: false;
            referencedRelation: 'product';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'product_bundle_component_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
        ];
      };
      product_stock: {
        Row: {
          low_stock_threshold: number;
          merchant_account_id: string;
          product_id: string;
          qty_on_hand: number;
          qty_reserved: number;
          unit_cost: number;
          updated_at: string;
        };
        Insert: {
          low_stock_threshold?: number;
          merchant_account_id: string;
          product_id: string;
          qty_on_hand?: number;
          qty_reserved?: number;
          unit_cost?: number;
          updated_at?: string;
        };
        Update: {
          low_stock_threshold?: number;
          merchant_account_id?: string;
          product_id?: string;
          qty_on_hand?: number;
          qty_reserved?: number;
          unit_cost?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'product_stock_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'product_stock_product_id_fkey';
            columns: ['product_id'];
            isOneToOne: true;
            referencedRelation: 'product';
            referencedColumns: ['id'];
          },
        ];
      };
      purchase_lot: {
        Row: {
          allocation_method: string;
          created_at: string;
          customs_total: number;
          estimated_lead_time_days: number | null;
          eta_override: string | null;
          freight_total: number;
          id: string;
          local_buffer_days: number;
          local_transport_total: number;
          merchant_account_id: string;
          ordered_at: string;
          received_at: string | null;
          reference: string | null;
          shipping_mode: string;
          status: string;
          supplier_name: string;
          supplier_prep_days: number;
          transit_total: number;
          transport_days: number;
          transport_total: number | null;
        };
        Insert: {
          allocation_method?: string;
          created_at?: string;
          customs_total?: number;
          estimated_lead_time_days?: number | null;
          eta_override?: string | null;
          freight_total?: number;
          id?: string;
          local_buffer_days?: number;
          local_transport_total?: number;
          merchant_account_id: string;
          ordered_at: string;
          received_at?: string | null;
          reference?: string | null;
          shipping_mode?: string;
          status?: string;
          supplier_name: string;
          supplier_prep_days?: number;
          transit_total?: number;
          transport_days?: number;
          transport_total?: number | null;
        };
        Update: {
          allocation_method?: string;
          created_at?: string;
          customs_total?: number;
          estimated_lead_time_days?: number | null;
          eta_override?: string | null;
          freight_total?: number;
          id?: string;
          local_buffer_days?: number;
          local_transport_total?: number;
          merchant_account_id?: string;
          ordered_at?: string;
          received_at?: string | null;
          reference?: string | null;
          shipping_mode?: string;
          status?: string;
          supplier_name?: string;
          supplier_prep_days?: number;
          transit_total?: number;
          transport_days?: number;
          transport_total?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: 'purchase_lot_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
        ];
      };
      purchase_lot_line: {
        Row: {
          allocated_fees: number | null;
          created_at: string;
          id: string;
          landed_total_value: number | null;
          landed_unit_cost: number | null;
          line_value: number | null;
          merchant_account_id: string;
          product_id: string;
          purchase_lot_id: string;
          purchase_price_total: number | null;
          qty: number;
          unit_purchase_price: number | null;
        };
        Insert: {
          allocated_fees?: number | null;
          created_at?: string;
          id?: string;
          landed_total_value?: number | null;
          landed_unit_cost?: number | null;
          line_value?: number | null;
          merchant_account_id: string;
          product_id: string;
          purchase_lot_id: string;
          purchase_price_total?: number | null;
          qty: number;
          unit_purchase_price?: number | null;
        };
        Update: {
          allocated_fees?: number | null;
          created_at?: string;
          id?: string;
          landed_total_value?: number | null;
          landed_unit_cost?: number | null;
          line_value?: number | null;
          merchant_account_id?: string;
          product_id?: string;
          purchase_lot_id?: string;
          purchase_price_total?: number | null;
          qty?: number;
          unit_purchase_price?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: 'purchase_lot_line_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'purchase_lot_line_product_id_fkey';
            columns: ['product_id'];
            isOneToOne: false;
            referencedRelation: 'product';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'purchase_lot_line_purchase_lot_id_fkey';
            columns: ['purchase_lot_id'];
            isOneToOne: false;
            referencedRelation: 'purchase_lot';
            referencedColumns: ['id'];
          },
        ];
      };
      settlement_allocation: {
        Row: {
          allocated_minor: number;
          created_at: string;
          id: string;
          merchant_account_id: string;
          order_id: string;
          settlement_id: string;
        };
        Insert: {
          allocated_minor: number;
          created_at?: string;
          id?: string;
          merchant_account_id: string;
          order_id: string;
          settlement_id: string;
        };
        Update: {
          allocated_minor?: number;
          created_at?: string;
          id?: string;
          merchant_account_id?: string;
          order_id?: string;
          settlement_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'settlement_allocation_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'settlement_allocation_order_id_fkey';
            columns: ['order_id'];
            isOneToOne: false;
            referencedRelation: 'orders';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'settlement_allocation_settlement_id_fkey';
            columns: ['settlement_id'];
            isOneToOne: false;
            referencedRelation: 'cash_settlement';
            referencedColumns: ['id'];
          },
        ];
      };
      settlement_shortfall: {
        Row: {
          created_at: string;
          driver_id: string;
          expected_minor: number;
          id: string;
          merchant_account_id: string;
          reason: string | null;
          received_minor: number;
          resolution: string;
          settlement_id: string;
          shortfall_minor: number | null;
        };
        Insert: {
          created_at?: string;
          driver_id: string;
          expected_minor: number;
          id?: string;
          merchant_account_id: string;
          reason?: string | null;
          received_minor: number;
          resolution?: string;
          settlement_id: string;
          shortfall_minor?: number | null;
        };
        Update: {
          created_at?: string;
          driver_id?: string;
          expected_minor?: number;
          id?: string;
          merchant_account_id?: string;
          reason?: string | null;
          received_minor?: number;
          resolution?: string;
          settlement_id?: string;
          shortfall_minor?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: 'settlement_shortfall_driver_id_fkey';
            columns: ['driver_id'];
            isOneToOne: false;
            referencedRelation: 'driver';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'settlement_shortfall_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'settlement_shortfall_settlement_id_fkey';
            columns: ['settlement_id'];
            isOneToOne: false;
            referencedRelation: 'cash_settlement';
            referencedColumns: ['id'];
          },
        ];
      };
      shop: {
        Row: {
          access_token_encrypted: string;
          access_token_expires_at: string | null;
          api_version: string;
          id: string;
          installed_at: string;
          last_reconciled_at: string | null;
          merchant_account_id: string;
          refresh_token_encrypted: string | null;
          refresh_token_expires_at: string | null;
          scopes: string;
          shop_domain: string;
          shop_gid: string | null;
          shopify_client_id: string | null;
          status: string;
          uninstalled_at: string | null;
          updated_at: string;
        };
        Insert: {
          access_token_encrypted: string;
          access_token_expires_at?: string | null;
          api_version?: string;
          id?: string;
          installed_at?: string;
          last_reconciled_at?: string | null;
          merchant_account_id: string;
          refresh_token_encrypted?: string | null;
          refresh_token_expires_at?: string | null;
          scopes: string;
          shop_domain: string;
          shop_gid?: string | null;
          shopify_client_id?: string | null;
          status?: string;
          uninstalled_at?: string | null;
          updated_at?: string;
        };
        Update: {
          access_token_encrypted?: string;
          access_token_expires_at?: string | null;
          api_version?: string;
          id?: string;
          installed_at?: string;
          last_reconciled_at?: string | null;
          merchant_account_id?: string;
          refresh_token_encrypted?: string | null;
          refresh_token_expires_at?: string | null;
          scopes?: string;
          shop_domain?: string;
          shop_gid?: string | null;
          shopify_client_id?: string | null;
          status?: string;
          uninstalled_at?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'shop_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
        ];
      };
      stock_movement: {
        Row: {
          created_at: string;
          created_by: string;
          driver_id: string | null;
          id: string;
          idempotency_key: string;
          merchant_account_id: string;
          movement_type: string;
          order_id: string | null;
          product_id: string;
          qty: number;
          reason: string | null;
          transition_id: string | null;
          unit_cost: number | null;
        };
        Insert: {
          created_at?: string;
          created_by: string;
          driver_id?: string | null;
          id?: string;
          idempotency_key: string;
          merchant_account_id: string;
          movement_type: string;
          order_id?: string | null;
          product_id: string;
          qty: number;
          reason?: string | null;
          transition_id?: string | null;
          unit_cost?: number | null;
        };
        Update: {
          created_at?: string;
          created_by?: string;
          driver_id?: string | null;
          id?: string;
          idempotency_key?: string;
          merchant_account_id?: string;
          movement_type?: string;
          order_id?: string | null;
          product_id?: string;
          qty?: number;
          reason?: string | null;
          transition_id?: string | null;
          unit_cost?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: 'stock_movement_driver_id_fkey';
            columns: ['driver_id'];
            isOneToOne: false;
            referencedRelation: 'driver';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'stock_movement_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'stock_movement_order_id_fkey';
            columns: ['order_id'];
            isOneToOne: false;
            referencedRelation: 'orders';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'stock_movement_product_id_fkey';
            columns: ['product_id'];
            isOneToOne: false;
            referencedRelation: 'product';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'stock_movement_transition_id_fkey';
            columns: ['transition_id'];
            isOneToOne: false;
            referencedRelation: 'order_state_transition';
            referencedColumns: ['id'];
          },
        ];
      };
      stock_reconciliation_alert: {
        Row: {
          delta: number;
          detected_at: string;
          id: string;
          ledger_qty_on_hand: number;
          merchant_account_id: string;
          product_id: string;
          stored_qty_on_hand: number;
        };
        Insert: {
          delta: number;
          detected_at?: string;
          id?: string;
          ledger_qty_on_hand: number;
          merchant_account_id: string;
          product_id: string;
          stored_qty_on_hand: number;
        };
        Update: {
          delta?: number;
          detected_at?: string;
          id?: string;
          ledger_qty_on_hand?: number;
          merchant_account_id?: string;
          product_id?: string;
          stored_qty_on_hand?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'stock_reconciliation_alert_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'stock_reconciliation_alert_product_id_fkey';
            columns: ['product_id'];
            isOneToOne: false;
            referencedRelation: 'product';
            referencedColumns: ['id'];
          },
        ];
      };
      user_consents: {
        Row: {
          accepted_at: string;
          content_hash: string;
          document_type: string;
          document_version: string;
          id: string;
          ip_address: unknown;
          method: string;
          user_agent: string | null;
          user_id: string;
        };
        Insert: {
          accepted_at?: string;
          content_hash: string;
          document_type: string;
          document_version: string;
          id?: string;
          ip_address?: unknown;
          method?: string;
          user_agent?: string | null;
          user_id: string;
        };
        Update: {
          accepted_at?: string;
          content_hash?: string;
          document_type?: string;
          document_version?: string;
          id?: string;
          ip_address?: unknown;
          method?: string;
          user_agent?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      webhook_event: {
        Row: {
          attempt_count: number;
          completed_at: string | null;
          id: string;
          last_error_code: string | null;
          lease_until: string | null;
          merchant_account_id: string | null;
          next_attempt_at: string | null;
          payload: Json | null;
          processed: boolean;
          processing_proof: Json | null;
          received_at: string;
          retention_attempt_count: number;
          retention_last_attempt_at: string | null;
          retention_last_error_code: string | null;
          retention_last_success_at: string | null;
          retention_next_attempt_at: string | null;
          shop_domain: string | null;
          shop_id: string | null;
          shopify_webhook_id: string;
          status: string;
          topic: string;
          triggered_at: string | null;
        };
        Insert: {
          attempt_count?: number;
          completed_at?: string | null;
          id?: string;
          last_error_code?: string | null;
          lease_until?: string | null;
          merchant_account_id?: string | null;
          next_attempt_at?: string | null;
          payload?: Json | null;
          processed?: boolean;
          processing_proof?: Json | null;
          received_at?: string;
          retention_attempt_count?: number;
          retention_last_attempt_at?: string | null;
          retention_last_error_code?: string | null;
          retention_last_success_at?: string | null;
          retention_next_attempt_at?: string | null;
          shop_domain?: string | null;
          shop_id?: string | null;
          shopify_webhook_id: string;
          status?: string;
          topic: string;
          triggered_at?: string | null;
        };
        Update: {
          attempt_count?: number;
          completed_at?: string | null;
          id?: string;
          last_error_code?: string | null;
          lease_until?: string | null;
          merchant_account_id?: string | null;
          next_attempt_at?: string | null;
          payload?: Json | null;
          processed?: boolean;
          processing_proof?: Json | null;
          received_at?: string;
          retention_attempt_count?: number;
          retention_last_attempt_at?: string | null;
          retention_last_error_code?: string | null;
          retention_last_success_at?: string | null;
          retention_next_attempt_at?: string | null;
          shop_domain?: string | null;
          shop_id?: string | null;
          shopify_webhook_id?: string;
          status?: string;
          topic?: string;
          triggered_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'webhook_event_merchant_account_id_fkey';
            columns: ['merchant_account_id'];
            isOneToOne: false;
            referencedRelation: 'merchant_account';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'webhook_event_shop_id_fkey';
            columns: ['shop_id'];
            isOneToOne: false;
            referencedRelation: 'shop';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      accept_invitation: { Args: { p_token: string }; Returns: Json };
      accept_pending_invitation_by_email: {
        Args: { p_invitation_id: string };
        Returns: Json;
      };
      cash_aging: {
        Args: { p_merchant: string };
        Returns: {
          bucket_1_3d: number;
          bucket_gt3d: number;
          bucket_lt1d: number;
          driver_id: string;
          driver_name: string;
          outstanding_minor: number;
        }[];
      };
      current_member_role: { Args: { p_account: string }; Returns: string };
      claim_shopify_dsar_artifacts: {
        Args: { p_limit: number; p_now?: string };
        Returns: {
          id: string;
          purge_attempt_count: number;
          storage_bucket: string;
          storage_path: string;
        }[];
      };
      claim_shopify_webhook_events: {
        Args: { p_event_id?: string; p_limit: number; p_now?: string };
        Returns: {
          attempt_count: number;
          id: string;
          merchant_account_id: string | null;
          payload: Json | null;
          shop_domain: string | null;
          shop_id: string | null;
          topic: string;
        }[];
      };
      execute_shopify_pcd_retention: {
        Args: { p_limit: number; p_now?: string };
        Returns: Json;
      };
      finalize_shopify_dsar_artifact_purge: {
        Args: { p_error_code?: string; p_id: string; p_now?: string; p_success: boolean };
        Returns: boolean;
      };
      preview_shopify_pcd_retention: {
        Args: { p_now?: string };
        Returns: {
          blocked_count: number;
          candidate_count: number;
          category: string;
          earliest_expiry: string | null;
          latest_expiry: string | null;
          shop_count: number;
        }[];
      };
      derive_legacy_cod_status: {
        Args: {
          p_call_state: string;
          p_cash_state: string;
          p_delivery_state: string;
          p_order_state: string;
        };
        Returns: string;
      };
      finish_shopify_webhook_event: {
        Args: {
          p_error_code?: string;
          p_event_id: string;
          p_outcome: string;
          p_proof?: Json;
        };
        Returns: boolean;
      };
      redact_shopify_customer_copies: {
        Args: {
          p_merchant_account_id: string;
          p_shop_id: string;
          p_shopify_customer_id: string;
          p_topic: string;
          p_webhook_event_id?: string;
        };
        Returns: Json;
      };
      finance_kpis: {
        Args: {
          p_from: string;
          p_merchant: string;
          p_shop_id?: string;
          p_to: string;
        };
        Returns: {
          a_encaisser: number;
          ca_livre: number;
          cash_chez_livreurs: number;
          delivered_orders_count: number;
          encaisse: number;
          taux_refus: number;
        }[];
      };
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
      get_dashboard_cash_collected_total: {
        Args: {
          p_from: string;
          p_merchant_id: string;
          p_shop_id?: string;
          p_to: string;
        };
        Returns: {
          ca_encaisse_minor: number;
          net_ca_minor: number;
          return_contra_revenue_minor: number;
        }[];
      };
      get_dashboard_cod_breakdown: {
        Args: {
          p_from: string;
          p_merchant_id: string;
          p_shop_id?: string;
          p_to: string;
        };
        Returns: Json;
      };
      get_dashboard_deliveries_by_product: {
        Args: {
          p_from: string;
          p_merchant_id: string;
          p_shop_id?: string;
          p_to: string;
        };
        Returns: Json;
      };
      get_dashboard_kpi: {
        Args: { p_merchant_id: string; p_shop_id?: string };
        Returns: Json;
      };
      get_dashboard_priority_counts: {
        Args: {
          p_merchant_id: string;
          p_shop_id?: string;
          p_since: string;
          p_until: string;
        };
        Returns: Json;
      };
      get_dashboard_shop_performance: {
        Args: {
          p_from: string;
          p_merchant_id: string;
          p_shop_id?: string;
          p_to: string;
        };
        Returns: Json;
      };
      get_dashboard_top_products: {
        Args: {
          p_from: string;
          p_merchant_id: string;
          p_shop_id?: string;
          p_to: string;
        };
        Returns: Json;
      };
      get_driver_cash_consolidation: {
        Args: {
          p_driver_id?: string;
          p_merchant_id: string;
          p_period_from?: string;
          p_period_to?: string;
          p_shop_id?: string;
        };
        Returns: {
          cash_on_hand_minor: number;
          collected_delivery_fees_minor: number;
          collected_minor: number;
          delivery_fees_minor: number;
          driver_id: string;
          driver_name: string;
          expected_minor: number;
          period_collected_delivery_fees_minor: number;
          period_collected_minor: number;
          period_delivery_fees_minor: number;
          period_remitted_minor: number;
          remitted_minor: number;
        }[];
      };
      get_driver_cash_outstanding_orders: {
        Args: { p_driver_id?: string; p_merchant_id: string };
        Returns: {
          delivered_at: string;
          driver_id: string;
          order_id: string;
          order_number: string;
          outstanding_minor: number;
        }[];
      };
      get_finance_collected_joins: {
        Args: {
          p_from: string;
          p_merchant_id: string;
          p_shop_id?: string;
          p_to: string;
        };
        Returns: Json;
      };
      get_finance_returned_joins: {
        Args: {
          p_from: string;
          p_merchant_id: string;
          p_shop_id?: string;
          p_to: string;
        };
        Returns: Json;
      };
      get_loss_analytics_joins: {
        Args: {
          p_from: string;
          p_merchant_id: string;
          p_shop_id?: string;
          p_to: string;
        };
        Returns: Json;
      };
      get_order_view_counts: {
        Args: {
          p_from: string;
          p_merchant_id: string;
          p_shop_id?: string;
          p_to: string;
        };
        Returns: {
          count: number;
          view_id: string;
        }[];
      };
      get_report_driver_cash_pending: {
        Args: {
          p_from: string;
          p_merchant_id: string;
          p_shop_id?: string;
          p_to: string;
        };
        Returns: {
          driver_id: string;
          driver_name: string;
          pending_minor: number;
        }[];
      };
      get_report_revenue_by_day: {
        Args: {
          p_from: string;
          p_merchant_id: string;
          p_shop_id?: string;
          p_to: string;
        };
        Returns: {
          amount_minor: number;
          day: string;
        }[];
      };
      get_report_status_breakdown: {
        Args: {
          p_from: string;
          p_merchant_id: string;
          p_shop_id?: string;
          p_to: string;
        };
        Returns: {
          amount_minor: number;
          cod_status: string;
          count: number;
        }[];
      };
      get_report_top_products: {
        Args: {
          p_from: string;
          p_merchant_id: string;
          p_shop_id?: string;
          p_to: string;
        };
        Returns: {
          amount_minor: number;
          quantity: number;
          title: string;
        }[];
      };
      ia_count_recent_tool_calls: {
        Args: { p_merchant_account_id: string; p_since: string };
        Returns: number;
      };
      ia_finance_cost_movements: {
        Args: { p_merchant: string; p_order_ids: string[] };
        Returns: {
          movement_type: string;
          order_id: string;
          product_id: string;
          qty: number;
          unit_cost: number;
        }[];
      };
      ia_product_cump: {
        Args: { p_merchant: string; p_product_ids: string[] };
        Returns: {
          product_id: string;
          unit_cost: number;
        }[];
      };
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
      list_my_pending_invitations: {
        Args: never;
        Returns: {
          expires_at: string;
          id: string;
          merchant_account_id: string;
          org_name: string;
          role: string;
        }[];
      };
      list_orders_keyset: {
        Args: {
          p_cursor_id?: string;
          p_cursor_sort?: string;
          p_from: string;
          p_limit?: number;
          p_merchant_id: string;
          p_shop_id?: string;
          p_to: string;
          p_view: string;
        };
        Returns: {
          assigned_driver_id: string;
          call_state: string;
          cash_state: string;
          cod_status: string;
          created_at: string;
          created_at_shopify: string;
          currency: string;
          customer_full_name: string;
          customer_id: string;
          customer_phone: string;
          delivery_state: string;
          id: string;
          items_summary: Json;
          next_action_at: string;
          next_contact_at: string;
          order_number: string;
          order_state: string;
          scheduled_for: string;
          shipping_address: Json;
          sort_at: string;
          source: string;
          total_amount: number;
        }[];
      };
      list_orders_paginated: {
        Args: {
          p_cursor_id?: string;
          p_cursor_sort?: string;
          p_limit?: number;
          p_merchant_id: string;
          p_search?: string;
          p_view?: string;
        };
        Returns: {
          assigned_driver_id: string;
          call_state: string;
          cash_state: string;
          cod_status: string;
          created_at: string;
          created_at_shopify: string;
          currency: string;
          customer_full_name: string;
          customer_id: string;
          customer_phone: string;
          delivery_state: string;
          id: string;
          items_summary: Json;
          next_action_at: string;
          next_contact_at: string;
          order_number: string;
          order_state: string;
          scheduled_for: string;
          shipping_address: Json;
          sort_at: string;
          source: string;
          total_amount: number;
        }[];
      };
      list_repeated_refusers: {
        Args: { p_limit?: number; p_merchant_id: string };
        Returns: {
          customer_id: string;
          full_name: string;
          order_count: number;
          refused_count: number;
          score: number;
          tier: string;
        }[];
      };
      lock_order_cart_replaceable: {
        Args: { p_order_id: string };
        Returns: {
          assigned_driver_id: string | null;
          attempt_count: number | null;
          call_confirmed_at: string | null;
          call_state: string | null;
          cancel_reason: string | null;
          cancel_reasons: string[] | null;
          cart_locally_modified_at: string | null;
          cash_collectable_minor: number | null;
          cash_collected_at: string | null;
          cash_state: string | null;
          cod_status: string;
          created_at: string;
          created_at_shopify: string | null;
          currency: string;
          customer_id: string | null;
          delivery_fee_minor: number;
          delivery_state: string | null;
          financial_status: string | null;
          fulfillment_status: string | null;
          id: string;
          items_summary: Json | null;
          merchant_account_id: string;
          next_action_at: string | null;
          next_contact_at: string | null;
          note: string | null;
          order_number: string | null;
          order_state: string | null;
          payment_channel_at_delivery: string | null;
          returned_at: string | null;
          scheduled_for: string | null;
          shipping_address: Json | null;
          shop_id: string | null;
          shopify_cancelled_at: string | null;
          shopify_financial_status: string | null;
          shopify_fulfillment_status: string | null;
          shopify_line_item_attributes: Json | null;
          shopify_order_attributes: Json | null;
          shopify_order_id: string | null;
          shopify_updated_at: string | null;
          sort_at: string | null;
          source: string | null;
          total_amount: number;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'orders';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      log_ia_tool_audit: {
        Args: {
          p_allowed: boolean;
          p_conversation_id?: string;
          p_denied_reason?: string;
          p_latency_ms?: number;
          p_merchant_account_id: string;
          p_tool_args: Json;
          p_tool_name: string;
          p_user_role: string;
        };
        Returns: string;
      };
      order_items_search_text: { Args: { p_items: Json }; Returns: string };
      orders_view_counts: {
        Args: { p_merchant_id: string; p_search?: string };
        Returns: {
          a_appeler: number;
          annulees_retours: number;
          confirmee: number;
          en_livraison: number;
          tentee_a_rappeler: number;
          toutes: number;
          valide: number;
        }[];
      };
      post_stock_movement: {
        Args: {
          p_created_by: string;
          p_driver_id?: string;
          p_idempotency_key: string;
          p_merchant_account_id: string;
          p_movement_type: string;
          p_order_id?: string;
          p_product_id: string;
          p_qty: number;
          p_reason?: string;
          p_received_value?: number;
          p_transition_id?: string;
          p_unit_cost?: number;
        };
        Returns: string;
      };
      reassign_order_driver: {
        Args: {
          p_actor: string;
          p_new_driver: string;
          p_note?: string;
          p_order_id: string;
        };
        Returns: undefined;
      };
      rebuild_product_stock: { Args: never; Returns: number };
      receive_purchase_lot: {
        Args: {
          p_actor_id: string;
          p_lines: Json;
          p_lot_id: string;
          p_merchant_account_id: string;
        };
        Returns: undefined;
      };
      reconcile_order_cod_status: {
        Args: never;
        Returns: {
          derived_cod_status: string;
          merchant_account_id: string;
          order_id: string;
          stored_cod_status: string;
        }[];
      };
      reconcile_product_stock: {
        Args: never;
        Returns: {
          delta: number;
          ledger_qty_on_hand: number;
          merchant_account_id: string;
          product_id: string;
          stored_qty_on_hand: number;
        }[];
      };
      record_cash_settlement: {
        Args: {
          p_actor?: string;
          p_allocations?: Json;
          p_amount_received_minor: number;
          p_client_request_id: string;
          p_driver: string;
          p_merchant: string;
          p_method: string;
          p_note: string;
        };
        Returns: Json;
      };
      reduce_order_cart_post_assignment: {
        Args: { p_lines: Json; p_order_id: string };
        Returns: undefined;
      };
      replace_order_cart: {
        Args: { p_lines: Json; p_order_id: string };
        Returns: undefined;
      };
      replace_shopify_order_cart: {
        Args: { p_lines: Json; p_order_id: string; p_order_update: Json };
        Returns: undefined;
      };
      reserve_manual_order_number: {
        Args: { p_merchant_account_id: string };
        Returns: string;
      };
      resolve_order_required_component_quantities: {
        Args: { p_order_id: string };
        Returns: {
          product_id: string;
          required_qty: number;
        }[];
      };
      set_order_note: {
        Args: { p_note: string; p_order_id: string };
        Returns: string;
      };
      sn_phone_e164: { Args: { p_value: string }; Returns: string };
      transition_order: {
        Args: {
          p_actor: string;
          p_assigned_driver_id?: string;
          p_attempt_count?: number;
          p_call_confirmed_at?: string;
          p_call_state?: string;
          p_cancel_reason?: string;
          p_cancel_reasons?: string[];
          p_cash_state?: string;
          p_clear_assigned_driver?: boolean;
          p_clear_cancel_reasons?: boolean;
          p_clear_scheduled_for?: boolean;
          p_delivered_at?: string;
          p_delivery_state?: string;
          p_invalidate_delivered?: boolean;
          p_next_contact_at?: string;
          p_note?: string;
          p_order_id: string;
          p_order_state?: string;
          p_payment_channel?: string;
          p_scheduled_for?: string;
        };
        Returns: string;
      };
      write_off_shortfall: {
        Args: {
          p_actor?: string;
          p_merchant: string;
          p_reason: string;
          p_shortfall_id: string;
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
