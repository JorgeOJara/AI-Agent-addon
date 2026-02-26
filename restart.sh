#!/bin/bash
# Restart the AI chatbot server
cd "$(dirname "$0")"
./stop.sh
sleep 1
./start.sh
