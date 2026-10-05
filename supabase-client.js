// supabase-client.js
// EcoTrack Supabase client

const SUPABASE_URL =
    'https://ldmwbxqjpunbuzxxpzkv.supabase.co';

const SUPABASE_PUBLISHABLE_KEY =
    'sb_publishable_VVF1TUG5OyZ6F74Iyx6Gpw_zknjcxIo';

// Create the Supabase client only once
if (!window.ecoTrackSupabase) {

    if (typeof window.supabase === 'undefined') {


      console.error(
            'Supabase JS library is not loaded.'
        );

    } else {

        window.ecoTrackSupabase =
            window.supabase.createClient(
                SUPABASE_URL,
                SUPABASE_PUBLISHABLE_KEY
            );

        console.log(
            'EcoTrack Supabase client initialized successfully.'
        );
    }

} else {

    console.log(
        'EcoTrack Supabase client already exists.'
    );
}