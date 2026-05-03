import { Layout } from "@/components/layout";
import { useSavedPicks } from "@/hooks/use-saved-picks";
import { StockCard } from "@/components/stock-card";
import { formatPercent, getColorClass } from "@/lib/format";
import { format, parseISO } from "date-fns";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Calendar } from "lucide-react";

export default function History() {
  const { savedPicks } = useSavedPicks();

  return (
    <Layout>
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <div className="mb-8">
          <h2 className="text-2xl font-bold tracking-tight">Saved History</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Review past momentum setups you've captured.
          </p>
        </div>

        {savedPicks.length === 0 ? (
          <div className="text-center p-12 border border-border border-dashed rounded-lg bg-card/30">
            <Calendar className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
            <h3 className="text-lg font-medium">No history yet</h3>
            <p className="text-muted-foreground mt-2">
              Save today's picks from the dashboard to start building your history.
            </p>
          </div>
        ) : (
          <Accordion type="multiple" defaultValue={[savedPicks[0]?.date]} className="space-y-4">
            {savedPicks.map((record) => (
              <AccordionItem 
                key={record.date} 
                value={record.date}
                className="border border-border rounded-lg bg-card overflow-hidden px-1"
              >
                <AccordionTrigger className="px-4 hover:no-underline hover:bg-accent/50 transition-colors">
                  <div className="flex items-center justify-between w-full pr-4">
                    <div className="flex items-center space-x-3">
                      <Calendar className="w-4 h-4 text-primary" />
                      <span className="font-semibold text-base">
                        {format(parseISO(record.date), "MMMM d, yyyy")}
                      </span>
                    </div>
                    <div className="text-sm text-muted-foreground font-normal">
                      Saved at {format(parseISO(record.fetchedAt), "HH:mm")}
                    </div>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-4 pt-2 bg-background border-t border-border">
                  {record.sectors.length === 0 ? (
                    <p className="text-muted-foreground text-sm italic py-4">No momentum sectors saved on this date.</p>
                  ) : (
                    <div className="space-y-6 mt-4">
                      {record.sectors.map(sector => (
                        <div key={sector.sectorKeyword} className="space-y-3">
                          <div className="flex items-baseline space-x-3 pb-1 border-b border-border/30">
                            <h4 className="font-semibold text-sm">{sector.sectorName}</h4>
                            <span className={`text-xs font-mono font-medium ${getColorClass(sector.sectorChangePct)}`}>
                              {formatPercent(sector.sectorChangePct)}
                            </span>
                            <span className="text-xs text-muted-foreground ml-auto">
                              {sector.stocks.length} stocks
                            </span>
                          </div>
                          {sector.stocks.length > 0 ? (
                            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                              {sector.stocks.map(stock => (
                                <StockCard key={stock.symbol} stock={stock} />
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground italic">No stocks</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </div>
    </Layout>
  );
}
