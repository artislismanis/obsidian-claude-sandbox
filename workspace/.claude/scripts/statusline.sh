#!/bin/sh
# Status line for Claude Code
input=$(cat)

model=$(echo "$input" | jq -r '.model.display_name // empty')
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
total_in=$(echo "$input" | jq -r '.context_window.total_input_tokens // empty')
total_out=$(echo "$input" | jq -r '.context_window.total_output_tokens // empty')
five_pct=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
five_resets=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')

# Model name in yellow
[ -n "$model" ] && printf '\033[00;33m[%s]\033[00m' "$model"

# Context used percentage in cyan
[ -n "$used" ] && printf ' \033[00;36mctx:%s%%\033[00m' "$(printf '%.0f' "$used")"

# Cumulative token counts (input in dim white, output in dim white)
if [ -n "$total_in" ] || [ -n "$total_out" ]; then
    in_val=${total_in:-0}
    out_val=${total_out:-0}
    # Format with k suffix for thousands
    in_fmt=$(awk "BEGIN { v=$in_val; if(v>=1000) printf \"%.1fk\", v/1000; else printf \"%d\", v }")
    out_fmt=$(awk "BEGIN { v=$out_val; if(v>=1000) printf \"%.1fk\", v/1000; else printf \"%d\", v }")
    printf ' \033[02;37min:%s out:%s\033[00m' "$in_fmt" "$out_fmt"
fi

# Rate limit: 5-hour used percentage and reset time
if [ -n "$five_pct" ]; then
    pct_fmt=$(printf '%.0f' "$five_pct")
    printf ' \033[00;35m5h:%s%%\033[00m' "$pct_fmt"
    if [ -n "$five_resets" ]; then
        now=$(date +%s)
        secs_left=$(( five_resets - now ))
        if [ "$secs_left" -le 0 ]; then
            printf ' \033[02;35m(now)\033[00m'
        elif [ "$secs_left" -lt 3600 ]; then
            mins=$(( secs_left / 60 ))
            printf ' \033[02;35m(%dm)\033[00m' "$mins"
        else
            hrs=$(( secs_left / 3600 ))
            mins=$(( (secs_left % 3600) / 60 ))
            printf ' \033[02;35m(%dh%dm)\033[00m' "$hrs" "$mins"
        fi
    fi
fi
