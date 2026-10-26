export interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  backgroundColor: string
  borderColor: string
  textColor: string
  classNames?: string[]
  extendedProps: {
    hostName:      string | null
    brandName:     string
    producerName:  string | null
    moderatorName: string | null
    notes:         string | null
    streamId:      string
    hostId:        string | null
    brandId:       string
    producerId:    string | null
    moderatorId:   string | null
  }
}
