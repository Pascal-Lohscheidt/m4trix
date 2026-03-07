export type SocketEventName =
  | 'conversation:create'
  | 'voice:input_file'
  | 'voice:input_chunk'
  | 'voice:input_commit'
  | 'voice:output_delta'
  | 'voice:output_commit'
  | 'voice:output_file'
  | 'voice:output_transcript_delta'
  | 'voice:output_transcript_full';
